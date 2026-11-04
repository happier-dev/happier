//! Request the actual mounted annotator; documents stay in its Capture renderer.
use super::CaptureState;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State, WebviewWindow};
use tokio::sync::oneshot;

const REQUEST_EVENT: &str = "desktopCapture://annotation-request";

fn unavailable() -> Value {
    serde_json::json!({"status": "unavailable", "reason": "annotation.targetUnavailable"})
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnnotationRequest<'a> {
    capture_ref: &'a str,
    request_id: u64,
    request: Value,
}

impl CaptureState {
    fn annotation_ready(&self, capture_ref: &str, label: &str, ready: bool) -> Result<(), String> {
        let mut operation = self.0.operation.lock().unwrap();
        let completed = operation.completed.get_mut(capture_ref)
            .filter(|completed| completed.window_label.as_deref() == Some(label) && completed.active.is_some())
            .ok_or("desktop_capture_annotation_caller_refused")?;
        completed.annotation_ready = ready;
        if !ready { completed.annotation_requests.clear(); }
        Ok(())
    }

    fn request_annotation(&self, capture_ref: &str) -> Option<(String, u64, oneshot::Receiver<Value>)> {
        let mut operation = self.0.operation.lock().unwrap();
        let completed = operation.completed.get_mut(capture_ref)
            .filter(|completed| completed.annotation_ready && completed.active.is_some())?;
        completed.next_annotation_request_id += 1;
        let request_id = completed.next_annotation_request_id;
        let (sender, receiver) = oneshot::channel();
        completed.annotation_requests.insert(request_id, sender);
        Some((completed.window_label.clone()?, request_id, receiver))
    }

    fn settle_annotation(&self, capture_ref: &str, label: &str, request_id: u64, result: Value) -> Result<(), String> {
        let mut operation = self.0.operation.lock().unwrap();
        let completed = operation.completed.get_mut(capture_ref)
            .filter(|completed| completed.window_label.as_deref() == Some(label))
            .ok_or("desktop_capture_annotation_caller_refused")?;
        if let Some(sender) = completed.annotation_requests.remove(&request_id) { let _ = sender.send(result); }
        Ok(())
    }
}

#[tauri::command]
pub fn desktop_capture_annotation_ready(state: State<'_, CaptureState>, window: WebviewWindow,
    capture_ref: String, ready: bool) -> Result<(), String> {
    state.annotation_ready(&capture_ref, window.label(), ready)
}

#[tauri::command]
pub async fn desktop_capture_annotation_request(app: AppHandle, state: State<'_, CaptureState>, window: WebviewWindow,
    capture_ref: String, request: Value) -> Result<Value, String> {
    if window.label() != crate::desktop_window::MAIN_WINDOW_LABEL {
        return Err("desktop_capture_annotation_caller_refused".into());
    }
    let Some((label, request_id, receiver)) = state.request_annotation(&capture_ref) else { return Ok(unavailable()); };
    if app.emit_to(&label, REQUEST_EVENT, AnnotationRequest { capture_ref: &capture_ref, request_id, request }).is_err() {
        state.settle_annotation(&capture_ref, &label, request_id, unavailable())?;
    }
    Ok(receiver.await.unwrap_or_else(|_| unavailable()))
}

#[tauri::command]
pub fn desktop_capture_annotation_result(state: State<'_, CaptureState>, window: WebviewWindow,
    capture_ref: String, request_id: u64, result: Value) -> Result<(), String> {
    state.settle_annotation(&capture_ref, window.label(), request_id, result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use happier_desktop_native::capture::RgbaFrame;

    #[test]
    fn requests_reach_only_the_ready_capture_and_hide_or_settlement_releases_waiters() {
        let state = CaptureState::default();
        let folder = tempfile::tempdir().unwrap();
        let png = RgbaFrame { width: 1, height: 1, rgba: vec![1, 2, 3, 255] }.png().unwrap();
        let mut captures = Vec::new();
        for _ in 0..2 {
            let capture = state.open_file(|files| files.write_png(folder.path(), &png)).unwrap();
            let label = state.window_label_for_capture(&capture.capture_ref).unwrap();
            captures.push((capture.capture_ref, label));
        }
        let (first, first_label) = &captures[0];
        let (second, second_label) = &captures[1];
        assert!(state.request_annotation(first).is_none(), "a webview's existence is not annotator readiness");
        assert!(state.annotation_ready(first, second_label, true).is_err());
        state.annotation_ready(first, first_label, true).unwrap();
        state.annotation_ready(second, second_label, true).unwrap();
        let (destination, request, mut result) = state.request_annotation(first).unwrap();
        assert_eq!(&destination, first_label);
        assert!(state.settle_annotation(first, second_label, request, Value::Null).is_err());
        let document = serde_json::json!({"marks": []});
        state.settle_annotation(first, first_label, request, document.clone()).unwrap();
        assert_eq!(result.try_recv().unwrap(), document);
        let (_, _, mut hidden) = state.request_annotation(first).unwrap();
        let (_, second_request, mut independent) = state.request_annotation(second).unwrap();
        state.cancel_window_text_for_window(first_label);
        assert_eq!(hidden.try_recv(), Err(oneshot::error::TryRecvError::Closed));
        assert_eq!(independent.try_recv(), Err(oneshot::error::TryRecvError::Empty));
        assert!(state.request_annotation(first).is_none());
        state.settle_annotation(second, second_label, second_request, document).unwrap();
        assert!(independent.try_recv().is_ok());
        let (_, _, mut settled) = state.request_annotation(second).unwrap();
        state.settle(second).unwrap();
        assert_eq!(settled.try_recv(), Err(oneshot::error::TryRecvError::Closed));
        assert!(state.request_annotation(second).is_none());
    }
}
