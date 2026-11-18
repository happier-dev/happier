#!/bin/sh
# The TypeScript inspection worker's esbuild service, run through this
# reporter (typescriptModuleInspection.ts). The service inherits its pipes
# directly; this process only waits for it and reports its exit on stderr,
# which the inspection session reads: the worker thread that owned the service
# may be gone, and the worker's blocked main thread cannot report it. The
# parent PID tells the worker's own service from one a grandchild started.
"$HAPPIER_INSPECTION_ESBUILD_BINARY" "$@"
status=$?
printf '\n__HAPPIER_INSPECTION_ESBUILD_EXIT__ %s %s\n' "$PPID" "$status" >&2
exit "$status"
