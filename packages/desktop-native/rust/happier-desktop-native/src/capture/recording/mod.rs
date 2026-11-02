//! One recording lifecycle. The OS stream and writer are the only backend boundary.
use super::{CaptureError, CaptureResult};
use serde::Serialize;
use std::sync::{Arc, Mutex, Weak};

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
mod macos_readiness;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod linux;
pub mod trim;
mod pixels;

/// The native writer chooses the container; allocation and delivery consume it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format { Mp4, Webm }
impl Format {
    pub fn extension(self) -> &'static str { match self { Self::Mp4 => "mp4", Self::Webm => "webm" } }
    pub fn mime_type(self) -> &'static str { match self { Self::Mp4 => "video/mp4", Self::Webm => "video/webm" } }
    pub fn from_mime_type(mime: &str) -> Result<Self, CaptureError> {
        match mime { "video/mp4" => Ok(Self::Mp4), "video/webm" => Ok(Self::Webm), _ => Err(CaptureError::InvalidMedia) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase { Preparing, Recording, Paused, Finalizing, Ready, Failed }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing { pub duration_ms: u64, pub active_since_ms: Option<u64> }

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase, pub timing: Timing, pub result: Option<CaptureResult>, pub error: Option<CaptureError>,
    /// Names an allocated, possibly unfinished source without claiming it is playable.
    pub source_ref: Option<String>,
}
impl Snapshot {
    pub fn preparing() -> Self { Self { phase: Phase::Preparing,
        timing: Timing { duration_ms: 0, active_since_ms: None }, result: None, error: None, source_ref: None } }
}

#[derive(Debug, Clone, Copy)]
pub struct Moment { pub steady_ns: u64, pub epoch_ms: u64 }

pub struct Timeline {
    snapshot: Snapshot,
    active_since_ns: u64,
    active_ns: u64,
    paused_at_ns: Option<u64>,
    paused_ns: u64,
    source_origin: Option<(u64, u64)>,
}
impl Timeline {
    fn new() -> Self { Self { snapshot: Snapshot::preparing(),
        active_since_ns: 0, active_ns: 0, paused_at_ns: None, paused_ns: 0, source_origin: None } }
    fn start(&mut self, now: Moment) { self.snapshot.phase = Phase::Recording;
        self.active_since_ns = now.steady_ns; self.snapshot.timing.active_since_ms = Some(now.epoch_ms); }
    fn pause(&mut self, now: Moment) { self.active_ns += now.steady_ns - self.active_since_ns;
        self.paused_at_ns = Some(now.steady_ns); self.snapshot.phase = Phase::Paused;
        self.snapshot.timing = Timing { duration_ms: self.active_ns / 1_000_000, active_since_ms: None }; }
    fn resume(&mut self, now: Moment) { self.paused_ns += now.steady_ns - self.paused_at_ns.take().unwrap();
        self.start(now); }
    /// The stream calls this before submitting a sample. Paused samples never reach the writer.
    pub fn sample_time(&mut self, source_ns: u64) -> Option<u64> {
        if self.snapshot.phase != Phase::Recording { return None; }
        let (origin, baseline_pause) = *self.source_origin.get_or_insert((source_ns, self.paused_ns));
        Some(source_ns.saturating_sub(origin).saturating_sub(self.paused_ns - baseline_pause))
    }
    fn settle_timing(&mut self, now: Moment) {
        if self.snapshot.phase == Phase::Recording { self.active_ns += now.steady_ns - self.active_since_ns; }
        self.snapshot.timing = Timing { duration_ms: self.active_ns / 1_000_000, active_since_ms: None };
    }
}

/// A genuine native stream/encoder boundary; finish must drain callbacks and await file completion.
pub trait Backend: Send {
    fn start(&mut self) -> Result<(), CaptureError>;
    /// An error means the writer did not complete. A completed movie may carry a
    /// source-stop warning, so callers can retain playable content and show why it stopped.
    fn finish(&mut self, duration_ns: u64) -> Result<Option<CaptureError>, CaptureError>;
    fn cancel(&mut self);
}
pub struct PreparedBackend {
    pub backend: Box<dyn Backend>,
    pub pixel_size: super::PixelSize,
    pub scale: Option<f64>,
    pub origin: Option<super::CaptureOrigin>,
    pub source: Option<super::CaptureSource>,
}
type Publish = Arc<dyn Fn(&Snapshot) + Send + Sync>;
type Clock = Arc<dyn Fn() -> Moment + Send + Sync>;
pub type Finalize = Box<dyn Fn() -> Result<CaptureResult, CaptureError> + Send + Sync>;

pub struct Session {
    pub timeline: Arc<Mutex<Timeline>>,
    backend: Mutex<Option<Box<dyn Backend>>>,
    publish: Publish, clock: Clock, finalize: Mutex<Option<Finalize>>,
    preparation_cancel: Mutex<Option<super::CancelSignal>>,
}
impl Session {
    pub fn start(make_backend: impl FnOnce(Arc<Mutex<Timeline>>, Weak<Session>) -> Result<(Box<dyn Backend>, Finalize), CaptureError>,
        publish: Publish, clock: Clock, register: impl FnOnce(Arc<Session>)) -> Result<Arc<Self>, CaptureError> {
        let session = Arc::new(Self { timeline: Arc::new(Mutex::new(Timeline::new())),
            backend: Mutex::new(None), publish, clock, finalize: Mutex::new(None), preparation_cancel: Mutex::new(None) });
        let mut current = session.backend.lock().unwrap();
        register(session.clone());
        (session.publish)(&session.snapshot());
        let prepared = make_backend(session.timeline.clone(), Arc::downgrade(&session));
        session.preparation_cancel.lock().unwrap().take();
        let (backend, finalize) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => { session.start_failed(error); return Err(error); }
        };
        *current = Some(backend);
        *session.finalize.lock().unwrap() = Some(finalize);
        if let Err(error) = current.as_mut().unwrap().start() {
            current.as_mut().unwrap().cancel(); current.take(); session.finalize.lock().unwrap().take();
            session.start_failed(error); return Err(error);
        }
        session.timeline.lock().unwrap().start((session.clock)());
        (session.publish)(&session.snapshot());
        drop(current);
        Ok(session)
    }
    fn start_failed(&self, error: CaptureError) {
        let mut timeline = self.timeline.lock().unwrap();
        timeline.snapshot.phase = Phase::Failed;
        timeline.snapshot.error = Some(error);
        let snapshot = timeline.snapshot.clone(); drop(timeline);
        (self.publish)(&snapshot);
    }
    pub fn snapshot(&self) -> Snapshot { self.timeline.lock().unwrap().snapshot.clone() }
    /// The host registers its existing finite-source cancellation before exposing
    /// this handle. Stop can then withdraw a pending system source dialog.
    pub fn bind_preparation_cancel(&self, cancel: super::CancelSignal) {
        *self.preparation_cancel.lock().unwrap() = Some(cancel);
    }
    pub fn set_source_ref(&self, capture_ref: String) {
        self.timeline.lock().unwrap().snapshot.source_ref = Some(capture_ref);
        (self.publish)(&self.snapshot());
    }
    pub fn pause(&self) -> Result<Snapshot, CaptureError> {
        let _serial = self.backend.lock().unwrap();
        let mut timeline = self.timeline.lock().unwrap();
        if timeline.snapshot.phase == Phase::Paused { return Ok(timeline.snapshot.clone()); }
        if timeline.snapshot.phase != Phase::Recording { return Err(CaptureError::OperationUnavailable); }
        timeline.pause((self.clock)());
        let snapshot = timeline.snapshot.clone(); drop(timeline);
        (self.publish)(&snapshot); Ok(snapshot)
    }
    pub fn resume(&self) -> Result<Snapshot, CaptureError> {
        let _serial = self.backend.lock().unwrap();
        let mut timeline = self.timeline.lock().unwrap();
        if timeline.snapshot.phase == Phase::Recording { return Ok(timeline.snapshot.clone()); }
        if timeline.snapshot.phase != Phase::Paused { return Err(CaptureError::OperationUnavailable); }
        timeline.resume((self.clock)());
        let snapshot = timeline.snapshot.clone(); drop(timeline);
        (self.publish)(&snapshot); Ok(snapshot)
    }
    pub fn stop(&self) -> Result<Snapshot, CaptureError> { self.finish(None, false) }
    /// Whether an explicit recovery retries only file adoption, without observing again.
    pub fn can_retry_finalization(&self) -> bool {
        let backend = self.backend.lock().unwrap();
        backend.is_none() && self.finalize.lock().unwrap().is_some()
    }
    pub fn fail(&self, error: CaptureError) -> Result<Snapshot, CaptureError> { self.finish(Some(error), false) }
    pub fn cancel(&self) -> Result<Snapshot, CaptureError> { self.finish(Some(CaptureError::Cancelled), true) }
    fn finish(&self, failure: Option<CaptureError>, cancel: bool) -> Result<Snapshot, CaptureError> {
        // Withdraw finite preparation before waiting for its native work. During
        // active capture this slot is empty and Stop uses the backend's EOS path.
        if let Some(preparation) = self.preparation_cancel.lock().unwrap().take() { preparation.cancel(); }
        let mut backend = self.backend.lock().unwrap();
        if backend.is_none() && self.finalize.lock().unwrap().is_none() { return Ok(self.snapshot()); }
        let duration_ns = { let mut timeline = self.timeline.lock().unwrap();
            timeline.settle_timing((self.clock)()); timeline.snapshot.phase = Phase::Finalizing;
            timeline.active_ns };
        (self.publish)(&self.snapshot());
        let native_finished = match backend.as_mut() {
            Some(native) if cancel => { native.cancel(); Err(CaptureError::Cancelled) },
            Some(native) => native.finish(duration_ns),
            None => Ok(None), // Explicit retry of file adoption, never another observation.
        };
        let completed = match native_finished {
            Ok(warning) => {
                let mut finalize = self.finalize.lock().unwrap();
                let result = finalize.as_ref().unwrap()().map(|result| (result, warning));
                if result.is_ok() { finalize.take(); }
                result
            },
            Err(error) => { self.finalize.lock().unwrap().take(); Err(error) },
        };
        // No terminal publication retains stream callbacks or encoder resources.
        drop(backend.take());
        let mut timeline = self.timeline.lock().unwrap();
        match completed {
            Ok((result, warning)) => { timeline.snapshot.result = Some(result); timeline.snapshot.error = failure.or(warning);
                timeline.snapshot.phase = if timeline.snapshot.error.is_some() { Phase::Failed } else { Phase::Ready }; },
            Err(error) => { timeline.snapshot.error = Some(error); timeline.snapshot.phase = Phase::Failed; },
        }
        let snapshot = timeline.snapshot.clone(); drop(timeline);
        (self.publish)(&snapshot); Ok(snapshot)
    }
}
impl Drop for Session {
    fn drop(&mut self) { if let Some(mut backend) = self.backend.get_mut().unwrap().take() { backend.cancel(); } }
}

pub fn clock() -> Clock {
    let origin = std::time::Instant::now();
    Arc::new(move || Moment { steady_ns: origin.elapsed().as_nanos() as u64,
        epoch_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn now(seconds: u64) -> Moment { Moment { steady_ns: seconds * 1_000_000_000, epoch_ms: seconds * 1_000 } }
    #[test]
    fn paused_samples_are_absent_and_resume_removes_the_paused_interval() {
        let mut timeline = Timeline::new(); timeline.start(now(10));
        assert_eq!(timeline.sample_time(100_000_000_000), Some(0));
        timeline.pause(now(11));
        assert_eq!(timeline.snapshot.timing, Timing { duration_ms: 1000, active_since_ms: None });
        assert_eq!(timeline.sample_time(105_000_000_000), None);
        timeline.resume(now(20));
        assert_eq!(timeline.sample_time(110_000_000_000), Some(1_000_000_000));
        assert_eq!(timeline.snapshot.timing, Timing { duration_ms: 1000, active_since_ms: Some(20_000) });
    }
    #[test]
    fn stop_cancels_pending_source_preparation_before_waiting_for_its_completion() {
        use std::sync::mpsc;
        let cancel = super::super::CancelSignal::default();
        let (registered, handle) = mpsc::channel();
        let (waiting, entered) = mpsc::channel();
        let (release, pending) = mpsc::channel();
        let wake = release.clone();
        let preparation = cancel.clone();
        let source = std::thread::spawn(move || Session::start(move |_, _| {
            preparation.on_cancel(move || { let _ = wake.send(()); });
            waiting.send(()).unwrap();
            pending.recv().unwrap();
            Err(CaptureError::Cancelled)
        }, Arc::new(|_| {}), Arc::new(|| now(10)), move |session| {
            session.bind_preparation_cancel(cancel); registered.send(session).unwrap();
        }));
        let session = handle.recv().unwrap();
        entered.recv().unwrap();
        let (done, stopped) = mpsc::channel();
        let stop = std::thread::spawn(move || { done.send(session.stop()).unwrap(); });
        // A test watchdog releases the genuine OS-boundary fixture if Stop fails
        // to cancel it; no product timeout or background worker is introduced.
        let completion = stopped.recv_timeout(std::time::Duration::from_secs(5));
        let _ = release.send(());
        stop.join().unwrap();
        assert!(source.join().unwrap().is_err());
        assert!(completion.is_ok(), "Stop must cancel pending native preparation, not wait for the person to close a source dialog");
        assert_eq!(completion.unwrap().unwrap().error, Some(CaptureError::Cancelled));
    }
    #[test]
    fn ready_is_published_only_after_native_finish_and_resource_drop() {
        struct Os { finished: Arc<AtomicBool>, dropped: Arc<AtomicBool> }
        impl Backend for Os {
            fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
            fn finish(&mut self, _: u64) -> Result<Option<CaptureError>, CaptureError> { self.finished.store(true, Ordering::SeqCst); Ok(None) }
            fn cancel(&mut self) {}
        }
        impl Drop for Os { fn drop(&mut self) { self.dropped.store(true, Ordering::SeqCst); } }
        let finished = Arc::new(AtomicBool::new(false)); let dropped = Arc::new(AtomicBool::new(false));
        let os = Os { finished: finished.clone(), dropped: dropped.clone() };
        let observed = dropped.clone();
        let session = Session::start(|_, _| Ok((Box::new(os), Box::new(|| Ok(CaptureResult { capture_ref: "movie".into(),
            kind: super::super::MediaKind::Video, path: "movie.mp4".into(), mime_type: "video/mp4".into(),
            byte_size: 24, pixel_size: super::super::PixelSize { width: 64, height: 48 }, scale: None,
            origin: None, source: None, window_text_ref: None })))), Arc::new(move |s| {
            if s.phase == Phase::Ready { assert!(observed.load(Ordering::SeqCst)); }
        }), Arc::new(|| now(10)), |_| {}).unwrap();
        let result = session.stop().unwrap();
        assert_eq!(result.phase, Phase::Ready);
        assert!(finished.load(Ordering::SeqCst)); assert!(dropped.load(Ordering::SeqCst));
    }
    #[test]
    fn failed_preparation_settles_the_registered_handle_instead_of_leaving_it_preparing() {
        let registered = Arc::new(Mutex::new(None));
        let handle = registered.clone();
        let publications = Arc::new(Mutex::new(Vec::new()));
        let observed = publications.clone();
        let result = Session::start(|_, _| Err(CaptureError::FileIo),
            Arc::new(move |snapshot| observed.lock().unwrap().push(snapshot.phase)),
            Arc::new(|| now(10)), move |session| *handle.lock().unwrap() = Some(session));
        assert!(matches!(result, Err(CaptureError::FileIo)));
        let snapshot = registered.lock().unwrap().as_ref().unwrap().snapshot();
        assert_eq!(snapshot.phase, Phase::Failed);
        assert_eq!(snapshot.error, Some(CaptureError::FileIo));
        assert_eq!(*publications.lock().unwrap(), vec![Phase::Preparing, Phase::Failed]);
    }
    #[test]
    fn file_adoption_retry_does_not_restart_or_refinish_the_native_writer() {
        use std::sync::atomic::AtomicUsize;
        struct Os(Arc<AtomicUsize>);
        impl Backend for Os {
            fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
            fn finish(&mut self, _: u64) -> Result<Option<CaptureError>, CaptureError> {
                self.0.fetch_add(1, Ordering::SeqCst); Ok(None)
            }
            fn cancel(&mut self) {}
        }
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("movie.mp4");
        let result = CaptureResult { capture_ref: "movie".into(), path: path.clone(),
            kind: super::super::MediaKind::Video, mime_type: "video/mp4".into(), byte_size: 0,
            pixel_size: super::super::PixelSize { width: 64, height: 48 }, scale: None,
            origin: None, source: None, window_text_ref: None };
        let files = Mutex::new(super::super::files::CaptureFiles::default());
        let finishes = Arc::new(AtomicUsize::new(0)); let native = finishes.clone();
        let session = Session::start(move |_, _| Ok((Box::new(Os(native)),
            Box::new(move || files.lock().unwrap().complete_video(result.clone())))),
            Arc::new(|_| {}), Arc::new(|| now(10)), |_| {}).unwrap();
        assert_eq!(session.stop().unwrap().phase, Phase::Failed);
        assert!(session.can_retry_finalization());
        std::fs::write(path, b"native completed bytes now accessible").unwrap();
        assert_eq!(session.stop().unwrap().phase, Phase::Ready);
        assert!(!session.can_retry_finalization());
        assert_eq!(finishes.load(Ordering::SeqCst), 1);
    }
}
