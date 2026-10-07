// The existing admission pressure cadence also reconciles placement while a
// worker demand remains queued. It is not an admission deadline or retry cap.
const baseSeconds = 3;
const spreadSeconds = 2;

export function resolveHeavyweightPressureRetryMilliseconds(pid = process.pid) {
  return (baseSeconds + pid % spreadSeconds) * 1000;
}

export function renderNativeHeavyweightPressureCadence() {
  return `heavyweight_pressure_retry_seconds_for_pid() { printf '%s' "$(( ${baseSeconds} + $1 % ${spreadSeconds} ))"; }`;
}
