use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use tokio::sync::watch;

use crate::error::NativeSshError;

static CANCELLATIONS: Lazy<Mutex<HashMap<String, watch::Sender<bool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub struct CancellationRegistration {
    request_id: String,
    receiver: watch::Receiver<bool>,
}

impl CancellationRegistration {
    pub fn receiver(&self) -> watch::Receiver<bool> {
        self.receiver.clone()
    }
}

impl Drop for CancellationRegistration {
    fn drop(&mut self) {
        if let Ok(mut cancellations) = CANCELLATIONS.lock() {
            cancellations.remove(&self.request_id);
        }
    }
}

pub fn register_request(request_id: &str) -> Result<CancellationRegistration, NativeSshError> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(NativeSshError::new(
            "engine-internal",
            "Invalid native SSH cancellation request.",
        ));
    }
    let (sender, receiver) = watch::channel(false);
    CANCELLATIONS
        .lock()
        .map_err(|_| {
            NativeSshError::new(
                "engine-internal",
                "Native SSH cancellation registry failed.",
            )
        })?
        .insert(request_id.to_string(), sender);
    Ok(CancellationRegistration {
        request_id: request_id.to_string(),
        receiver,
    })
}

pub fn cancel_request(request_id: &str) {
    if let Ok(mut cancellations) = CANCELLATIONS.lock() {
        if let Some(sender) = cancellations.remove(request_id.trim()) {
            let _ = sender.send(true);
        }
    }
}

pub async fn wait_for_cancellation(receiver: &mut watch::Receiver<bool>) {
    if *receiver.borrow() {
        return;
    }
    while receiver.changed().await.is_ok() {
        if *receiver.borrow() {
            return;
        }
    }
}

pub fn cancellation_error() -> NativeSshError {
    NativeSshError::new("cancellation", "Native SSH request was cancelled.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_notifies_registered_request() {
        let registration = register_request("request-a").expect("registration succeeds");
        let mut receiver = registration.receiver();

        cancel_request("request-a");
        wait_for_cancellation(&mut receiver).await;

        assert!(*receiver.borrow());
    }

    #[tokio::test]
    async fn dropped_registration_does_not_cancel_reused_request_id() {
        {
            let _first = register_request("request-reused").expect("registration succeeds");
        }
        let second = register_request("request-reused").expect("registration succeeds");
        let mut receiver = second.receiver();

        cancel_request("request-reused");
        wait_for_cancellation(&mut receiver).await;

        assert!(*receiver.borrow());
    }
}
