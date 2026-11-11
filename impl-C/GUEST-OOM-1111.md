GUEST-OOM-1111 — verdict: [blocked] diagnosis cannot be closed safely.

Observed: retained Machine 5bd20164-ef41-4de5-9989-be25118bde8d maps to managed Lima guest happier-jms44hvppno430sw2cjnfunqtgyz8xn4gscc4mqhybacw20ey on nl3. Native read showed Stopped, qemu/x86_64, 2 CPUs and 4 GiB (not the requested 4 CPU claim); lima.yaml is 2 CPU/4GiB/16GiB. Guest shell was refused because it was stopped. A retry at 09:26Z was refused because nl3 synchronization was unavailable. Host serial/HA logs contained no kernel OOM marker and ended in normal SIGINT/QEMU powerdown.

Missing: journalctl -k/dmesg, killed PID/RSS, daemon RSS, other process/Node heap RSS, free memory, and 60-second /proc samples for ~10 minutes. The 11-10 08:00Z/583 MiB datum remains unverified here.

Cause: [blocked]. The shared CLI owner has a process-wide moduleLoadCache and eager startup families, both candidates only; no measured retention/footprint evidence promotes either to root cause. Managed Lima presets are 8–14 CPU and 16–72 GiB, so changing a preset from this stopped 2 CPU/4 GiB guest would be invented.

Fix/commit: no source fix is justified; no restart loop, heap flag, or new cap added. RED/GREEN and entry-loads were not run because the owner defect is unproven. Commit contains this report and raw read artifacts only.

Sweep: Cua BYOC option maps are per invocation; Lume registry-token map is per invocation; Lima executor returns bounded native output and has no guest-global cache. No Cua/Lume/cloud-specific duplicate retainer found; shared CLI module/activation owners remain the next measured corridor.

Residual: rerun the native read on a running retained guest, capture the missing kernel/process/RSS series, then fix the measured producer/retainer or the preset owner. No guest write, restart, stack lifecycle, or typecheck was performed.
