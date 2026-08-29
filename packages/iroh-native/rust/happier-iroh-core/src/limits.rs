use crate::{IrohError, Result};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Debug, Clone, Copy)]
pub struct IrohTunnelLimits {
    pub max_connections: usize,
    pub max_streams: usize,
    pub receive_window: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IrohCapProfile {
    HomeInteractive,
    MachineBulk,
    WorkspaceSync,
}

impl IrohCapProfile {
    pub const fn limits(self) -> IrohTunnelLimits {
        match self {
            Self::HomeInteractive => IrohTunnelLimits {
                max_connections: 2,
                max_streams: 64,
                receive_window: 16 * 1024 * 1024,
            },
            Self::MachineBulk => IrohTunnelLimits {
                max_connections: 2,
                max_streams: 32,
                receive_window: 64 * 1024 * 1024,
            },
            Self::WorkspaceSync => IrohTunnelLimits {
                max_connections: 2,
                max_streams: 8,
                receive_window: 32 * 1024 * 1024,
            },
        }
    }
}
impl Default for IrohTunnelLimits {
    fn default() -> Self {
        Self {
            max_connections: 64,
            max_streams: 256,
            receive_window: 1024 * 1024,
        }
    }
}
#[derive(Clone)]
pub struct ResourceLimiter {
    inner: Arc<(Mutex<(usize, usize)>, Condvar)>,
    limits: IrohTunnelLimits,
}
impl ResourceLimiter {
    pub fn new(limits: IrohTunnelLimits) -> Self {
        Self {
            inner: Arc::new((Mutex::new((0, 0)), Condvar::new())),
            limits,
        }
    }
    pub fn acquire_connection(&self) -> Result<IrohConnectionPermit> {
        self.acquire(true).map(|_| IrohConnectionPermit {
            limiter: self.clone(),
        })
    }
    pub fn acquire_stream(&self) -> Result<IrohStreamPermit> {
        self.acquire(false).map(|_| IrohStreamPermit {
            limiter: self.clone(),
        })
    }
    fn acquire(&self, connection: bool) -> Result<()> {
        let (lock, _) = &*self.inner;
        let mut state = lock.lock().map_err(|_| IrohError::ResourceLimit)?;
        let used = if connection {
            &mut state.0
        } else {
            &mut state.1
        };
        let max = if connection {
            self.limits.max_connections
        } else {
            self.limits.max_streams
        };
        if *used >= max {
            return Err(IrohError::ResourceLimit);
        }
        *used += 1;
        Ok(())
    }
    fn release(&self, connection: bool) {
        if let Ok(mut s) = self.inner.0.lock() {
            if connection {
                s.0 = s.0.saturating_sub(1)
            } else {
                s.1 = s.1.saturating_sub(1)
            }
            self.inner.1.notify_one();
        }
    }
}
pub struct IrohConnectionPermit {
    limiter: ResourceLimiter,
}
pub struct IrohStreamPermit {
    limiter: ResourceLimiter,
}
impl Drop for IrohConnectionPermit {
    fn drop(&mut self) {
        self.limiter.release(true)
    }
}
impl Drop for IrohStreamPermit {
    fn drop(&mut self) {
        self.limiter.release(false)
    }
}
