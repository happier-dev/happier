pub mod auth;
pub mod cancellation;
pub mod connection;
pub mod engine;
pub mod error;
pub mod events;
pub mod exec;
pub mod host_key;
pub mod tunnel;
pub mod types;

use std::ffi::{c_char, CStr, CString};
use std::ptr;
use std::sync::Arc;

use crate::cancellation::cancel_request;
use crate::engine::run_exec_blocking;
use crate::error::NativeSshErrorPayload;
use crate::host_key::RejectingHostKeyPrompter;
use crate::tunnel::{start_loopback_tunnel_blocking, stop_loopback_tunnel};
use crate::types::{NativeSshExecRequest, NativeSshLoopbackTunnelRequest};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSshJsonResponse<T: serde::Serialize> {
    ok: bool,
    result: Option<T>,
    error: Option<NativeSshErrorPayload>,
}

#[no_mangle]
pub extern "C" fn happier_ssh_native_free_string(value: *mut c_char) {
    if value.is_null() {
        return;
    }
    unsafe {
        drop(CString::from_raw(value));
    }
}

#[no_mangle]
pub extern "C" fn happier_ssh_native_exec_json(request_json: *const c_char) -> *mut c_char {
    let result = read_c_string(request_json)
        .and_then(|json| serde_json::from_str::<NativeSshExecRequest>(&json).map_err(Into::into))
        .and_then(|request| run_exec_blocking(request, Arc::new(RejectingHostKeyPrompter)));
    write_json_response(result)
}

#[no_mangle]
pub extern "C" fn happier_ssh_native_start_loopback_tunnel_json(
    request_json: *const c_char,
) -> *mut c_char {
    let result = read_c_string(request_json)
        .and_then(|json| {
            serde_json::from_str::<NativeSshLoopbackTunnelRequest>(&json).map_err(Into::into)
        })
        .and_then(start_loopback_tunnel_blocking);
    write_json_response(result)
}

#[no_mangle]
pub extern "C" fn happier_ssh_native_stop_loopback_tunnel_json(
    tunnel_id: *const c_char,
) -> *mut c_char {
    let result = read_c_string(tunnel_id).map(|id| {
        stop_loopback_tunnel(&id);
        serde_json::json!({})
    });
    write_json_response(result)
}

#[no_mangle]
pub extern "C" fn happier_ssh_native_cancel_request_json(request_id: *const c_char) -> *mut c_char {
    let result = read_c_string(request_id).map(|id| {
        cancel_request(&id);
        serde_json::json!({})
    });
    write_json_response(result)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_happier_ssh_HappierSshNativeRust_execJson<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    request_json: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    let request = match env.get_string(&request_json) {
        Ok(value) => value.to_string_lossy().into_owned(),
        Err(_) => String::new(),
    };
    let c_request = match CString::new(request) {
        Ok(value) => value,
        Err(_) => CString::new("{}").expect("static JSON is a valid CString"),
    };
    let response = happier_ssh_native_exec_json(c_request.as_ptr());
    if response.is_null() {
        return ptr::null_mut();
    }
    let response_text = unsafe { CStr::from_ptr(response) }
        .to_string_lossy()
        .into_owned();
    happier_ssh_native_free_string(response);
    match env.new_string(response_text) {
        Ok(value) => value.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_happier_ssh_HappierSshNativeRust_startLoopbackTunnelJson<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    request_json: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    call_json_ffi(
        &mut env,
        request_json,
        happier_ssh_native_start_loopback_tunnel_json,
    )
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_happier_ssh_HappierSshNativeRust_stopLoopbackTunnelJson<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    tunnel_id: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    call_json_ffi(
        &mut env,
        tunnel_id,
        happier_ssh_native_stop_loopback_tunnel_json,
    )
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_dev_happier_ssh_HappierSshNativeRust_cancelRequestJson<'local>(
    mut env: jni::JNIEnv<'local>,
    _class: jni::objects::JClass<'local>,
    request_id: jni::objects::JString<'local>,
) -> jni::sys::jstring {
    call_json_ffi(&mut env, request_id, happier_ssh_native_cancel_request_json)
}

#[cfg(target_os = "android")]
fn call_json_ffi<'local>(
    env: &mut jni::JNIEnv<'local>,
    input: jni::objects::JString<'local>,
    ffi: extern "C" fn(*const c_char) -> *mut c_char,
) -> jni::sys::jstring {
    let request = match env.get_string(&input) {
        Ok(value) => value.to_string_lossy().into_owned(),
        Err(_) => String::new(),
    };
    let c_request = match CString::new(request) {
        Ok(value) => value,
        Err(_) => CString::new("{}").expect("static JSON is a valid CString"),
    };
    let response = ffi(c_request.as_ptr());
    if response.is_null() {
        return ptr::null_mut();
    }
    let response_text = unsafe { CStr::from_ptr(response) }
        .to_string_lossy()
        .into_owned();
    happier_ssh_native_free_string(response);
    match env.new_string(response_text) {
        Ok(value) => value.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

fn read_c_string(value: *const c_char) -> Result<String, crate::error::NativeSshError> {
    if value.is_null() {
        return Err(crate::error::NativeSshError::new(
            "engine-internal",
            "Invalid native SSH request.",
        ));
    }
    let text = unsafe { CStr::from_ptr(value) }.to_str().map_err(|_| {
        crate::error::NativeSshError::new("engine-internal", "Invalid native SSH request.")
    })?;
    Ok(text.to_string())
}

fn write_json_response<T: serde::Serialize>(
    result: Result<T, crate::error::NativeSshError>,
) -> *mut c_char {
    let payload = match result {
        Ok(result) => NativeSshJsonResponse {
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => NativeSshJsonResponse::<T> {
            ok: false,
            result: None,
            error: Some(error.payload()),
        },
    };
    match serde_json::to_string(&payload)
        .ok()
        .and_then(|json| CString::new(json).ok())
    {
        Some(value) => value.into_raw(),
        None => ptr::null_mut(),
    }
}
