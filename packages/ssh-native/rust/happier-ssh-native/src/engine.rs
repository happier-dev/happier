use std::sync::Arc;

use crate::cancellation::register_request;
use crate::error::NativeSshError;
use crate::exec::exec;
use crate::host_key::HostKeyPrompter;
use crate::types::{NativeSshExecRequest, NativeSshExecResult};

pub fn run_exec_blocking(
    request: NativeSshExecRequest,
    prompter: Arc<dyn HostKeyPrompter>,
) -> Result<NativeSshExecResult, NativeSshError> {
    let cancellation = register_request(&request.request_id)?;
    let receiver = cancellation.receiver();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| {
            NativeSshError::new("engine-internal", "Native SSH runtime could not start.")
        })?;
    runtime.block_on(exec(request, prompter, receiver))
}
