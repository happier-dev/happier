//! Decoding of the opaque native window handle a desktop shell hands to this
//! addon.
//!
//! Both shells produce the same thing on macOS: a byte buffer whose contents are
//! a host-endian `NSView *` for the window's content view (Electron's
//! `BrowserWindow.getNativeWindowHandle()`; Tauri's `WebviewWindow::ns_view()`
//! returns the pointer directly and is wrapped by the caller).
//!
//! Everything in this module is pure and runs headlessly, so the guards that
//! stand between untrusted JavaScript input and an `unsafe` dereference are unit
//! tested without a GUI.

use core::ffi::c_void;
use core::ptr::NonNull;

/// Why a caller-supplied handle cannot be turned into a pointer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleError {
    /// The buffer is smaller than one pointer.
    TooShort { len: usize, required: usize },
    /// The buffer decoded to a null pointer.
    Null,
    /// The buffer decoded to an address that cannot be an Objective-C object
    /// because it is not pointer-aligned.
    Misaligned { address: usize },
}

impl HandleError {
    pub fn message(self) -> String {
        match self {
            HandleError::TooShort { len, required } => format!(
                "native window handle must be at least {required} bytes, received {len}"
            ),
            HandleError::Null => "native window handle decoded to a null pointer".to_owned(),
            HandleError::Misaligned { address } => format!(
                "native window handle decoded to misaligned address 0x{address:x}; expected {}-byte alignment",
                POINTER_SIZE
            ),
        }
    }
}

pub const POINTER_SIZE: usize = core::mem::size_of::<usize>();

/// Decode the handle buffer to the raw address, rejecting every shape that would
/// make the subsequent dereference undefined behaviour.
///
/// A pointer that is well-formed here can still be stale or foreign; that
/// residual risk is narrowed by the Objective-C class check performed by the
/// caller before the pointer is used as an object.
pub fn decode_view_address(bytes: &[u8]) -> Result<NonNull<c_void>, HandleError> {
    if bytes.len() < POINTER_SIZE {
        return Err(HandleError::TooShort {
            len: bytes.len(),
            required: POINTER_SIZE,
        });
    }

    let mut raw = [0u8; POINTER_SIZE];
    raw.copy_from_slice(&bytes[..POINTER_SIZE]);
    let address = usize::from_ne_bytes(raw);

    if address == 0 {
        return Err(HandleError::Null);
    }
    if address % POINTER_SIZE != 0 {
        return Err(HandleError::Misaligned { address });
    }

    NonNull::new(address as *mut c_void).ok_or(HandleError::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_buffer() {
        assert_eq!(
            decode_view_address(&[]),
            Err(HandleError::TooShort {
                len: 0,
                required: POINTER_SIZE
            })
        );
    }

    #[test]
    fn rejects_a_buffer_shorter_than_a_pointer() {
        assert_eq!(
            decode_view_address(&[1, 2, 3]),
            Err(HandleError::TooShort {
                len: 3,
                required: POINTER_SIZE
            })
        );
    }

    #[test]
    fn rejects_a_null_pointer() {
        assert_eq!(decode_view_address(&[0u8; POINTER_SIZE]), Err(HandleError::Null));
    }

    #[test]
    fn rejects_a_misaligned_pointer() {
        let address: usize = 0x0000_6000_0123_4561;
        assert_eq!(
            decode_view_address(&address.to_ne_bytes()),
            Err(HandleError::Misaligned { address })
        );
    }

    #[test]
    fn decodes_a_host_endian_pointer() {
        let address: usize = 0x0000_6000_0123_4560;
        let decoded = decode_view_address(&address.to_ne_bytes()).expect("aligned pointer");
        assert_eq!(decoded.as_ptr() as usize, address);
    }

    #[test]
    fn tolerates_a_buffer_longer_than_a_pointer() {
        let address: usize = 0x0000_7fff_1234_5678;
        let mut bytes = address.to_ne_bytes().to_vec();
        bytes.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
        let decoded = decode_view_address(&bytes).expect("aligned pointer");
        assert_eq!(decoded.as_ptr() as usize, address);
    }

    #[test]
    fn every_error_renders_a_message_naming_the_failure() {
        assert!(HandleError::Null.message().contains("null"));
        assert!(HandleError::TooShort { len: 3, required: 8 }
            .message()
            .contains("received 3"));
        assert!(HandleError::Misaligned { address: 0x11 }
            .message()
            .contains("0x11"));
    }
}
