//! Observe the push writer's readiness, including terminal encoder failures.
use crate::capture::CaptureError;
use objc2::{class, msg_send, rc::Retained, runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel}, sel};
use objc2_foundation::NSString;
use std::{ffi::c_void, sync::{mpsc, OnceLock}};

extern "C" fn changed(_: *mut AnyObject, _: Sel, _: *mut NSString, _: *mut AnyObject,
    _: *mut AnyObject, context: *mut c_void) {
    // The observation owns this stable context until both observers are removed.
    let signal = unsafe { &*context.cast::<mpsc::Sender<()>>() };
    let _ = signal.send(());
}

fn observer_class() -> &'static AnyClass {
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    CLASS.get_or_init(|| {
        let mut builder = ClassBuilder::new(c"HappierRecordingReadinessObserver", class!(NSObject)).unwrap();
        unsafe {
            builder.add_method(sel!(observeValueForKeyPath:ofObject:change:context:),
                changed as extern "C" fn(*mut AnyObject, Sel, *mut NSString, *mut AnyObject, *mut AnyObject, *mut c_void));
        }
        builder.register()
    })
}

pub(super) struct Readiness<'a> {
    input: &'a AnyObject,
    writer: &'a AnyObject,
    observer: Retained<AnyObject>,
    keys: [Retained<NSString>; 2],
    signal: Box<mpsc::Sender<()>>,
    updates: mpsc::Receiver<()>,
}
impl<'a> Readiness<'a> {
    pub(super) fn new(input: &'a AnyObject, writer: &'a AnyObject) -> Self {
        let (signal, updates) = mpsc::channel();
        let observation = Self { input, writer, observer: unsafe { msg_send![observer_class(), new] },
            keys: [NSString::from_str("readyForMoreMediaData"), NSString::from_str("status")],
            signal: Box::new(signal), updates };
        for (object, key) in [input, writer].into_iter().zip(&observation.keys) { unsafe {
            let _: () = msg_send![object, addObserver: &*observation.observer, forKeyPath: &**key,
                options: 0usize, context: observation.context()];
        } }
        observation
    }
    fn context(&self) -> *mut c_void { (&*self.signal as *const mpsc::Sender<()>).cast_mut().cast() }
    pub(super) fn wait(&self) -> Result<(), CaptureError> {
        loop {
            let status: isize = unsafe { msg_send![self.writer, status] };
            if status != 1 { return Err(CaptureError::FileIo); }
            let ready: Bool = unsafe { msg_send![self.input, isReadyForMoreMediaData] };
            if ready.as_bool() { return Ok(()); }
            // Registration precedes the state read, so a racing transition stays
            // queued. No polling, deadline, or callback on a second append path.
            self.updates.recv().map_err(|_| CaptureError::NativeFailure)?;
        }
    }
}
impl Drop for Readiness<'_> {
    fn drop(&mut self) {
        for (object, key) in [self.input, self.writer].into_iter().zip(&self.keys) { unsafe {
            let _: () = msg_send![object, removeObserver: &*self.observer,
                forKeyPath: &**key, context: self.context()];
        } }
    }
}
