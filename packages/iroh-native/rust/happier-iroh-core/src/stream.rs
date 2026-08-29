use crate::{IrohError, Result};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub trait DuplexStream: Read + Write + Send {}
impl<T: Read + Write + Send> DuplexStream for T {}
#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release)
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
#[derive(Debug, Clone, Copy)]
pub struct CopyLimits {
    pub max_bytes: Option<u64>,
    pub buffer_size: usize,
}
impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            max_bytes: None,
            buffer_size: 16 * 1024,
        }
    }
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct DirectionStats {
    pub bytes: u64,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct CopyStats {
    pub left_to_right: DirectionStats,
    pub right_to_left: DirectionStats,
}
pub fn copy_bidirectional<L: DuplexStream, R: DuplexStream>(
    left: &mut L,
    right: &mut R,
    cancel: &CancellationToken,
    limits: CopyLimits,
) -> Result<CopyStats> {
    // This borrowed convenience API drains both directions while retaining
    // Rust's aliasing guarantees. Native adapters use their async split halves
    // and can call `copy_split_bidirectional` for simultaneous pumping.
    let left_to_right = copy_one(
        left,
        right,
        cancel,
        limits.buffer_size.max(1),
        limits.max_bytes,
    )?;
    let right_to_left = copy_one(
        right,
        left,
        cancel,
        limits.buffer_size.max(1),
        limits.max_bytes,
    )?;
    Ok(CopyStats {
        left_to_right: DirectionStats {
            bytes: left_to_right,
        },
        right_to_left: DirectionStats {
            bytes: right_to_left,
        },
    })
}

/// Concurrent copier for streams that expose independent owned read/write
/// halves (for example Tokio TCP/QUIC streams). This is the production path;
/// the borrowed helper above remains useful for deterministic single-threaded
/// fixtures.
pub fn copy_split_bidirectional<
    LR: Read + Send + 'static,
    LW: Write + Send + 'static,
    RR: Read + Send + 'static,
    RW: Write + Send + 'static,
>(
    left_read: LR,
    left_write: LW,
    right_read: RR,
    right_write: RW,
    cancel: &CancellationToken,
    limits: CopyLimits,
) -> Result<CopyStats> {
    let cancel_left = cancel.clone();
    let cancel_right = cancel.clone();
    let buffer_size = limits.buffer_size.max(1);
    let max_bytes = limits.max_bytes;
    let left_task = std::thread::spawn(move || {
        let mut reader = left_read;
        let mut writer = right_write;
        copy_one(
            &mut reader,
            &mut writer,
            &cancel_left,
            buffer_size,
            max_bytes,
        )
    });
    let right_task = std::thread::spawn(move || {
        let mut reader = right_read;
        let mut writer = left_write;
        copy_one(
            &mut reader,
            &mut writer,
            &cancel_right,
            buffer_size,
            max_bytes,
        )
    });
    let left_to_right = left_task
        .join()
        .unwrap_or(Err(IrohError::TransportClosed))?;
    let right_to_left = right_task
        .join()
        .unwrap_or(Err(IrohError::TransportClosed))?;
    Ok(CopyStats {
        left_to_right: DirectionStats {
            bytes: left_to_right,
        },
        right_to_left: DirectionStats {
            bytes: right_to_left,
        },
    })
}

fn copy_one<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    cancel: &CancellationToken,
    buffer_size: usize,
    max_bytes: Option<u64>,
) -> Result<u64> {
    let mut buf = vec![0; buffer_size];
    let mut bytes = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Err(IrohError::Cancelled);
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(bytes);
        }
        bytes = bytes.saturating_add(n as u64);
        if max_bytes.is_some_and(|max| bytes > max) {
            cancel.cancel();
            return Err(IrohError::ResourceLimit);
        }
        writer.write_all(&buf[..n])?;
    }
}
