export function createTuiSummaryRefresh(refresh) {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    const pending = Promise.resolve().then(refresh).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  };
}
