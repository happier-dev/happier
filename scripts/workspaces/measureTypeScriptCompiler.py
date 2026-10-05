"""Linux CI wait4 measurement beneath the existing foreground group custodian."""

import errno
import json
import os
import signal
import subprocess
import sys


# The custodian broadcasts cancellation to this same process group. Keep this
# leaf alive until the compiler finishes so its result and descendants retain
# custody even when the compiler handles TERM gracefully or delays completion.
for cancellation in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(cancellation, lambda _signal, _frame: None)

try:
    child = subprocess.Popen(sys.argv[2:])
except OSError as error:
    result = {"error": {"message": str(error), "code": errno.errorcode.get(error.errno)}}
else:
    _, status, usage = os.wait4(child.pid, 0)
    child.returncode = os.waitstatus_to_exitcode(status)
    result = {
        "status": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
        "signal": signal.Signals(os.WTERMSIG(status)).name if os.WIFSIGNALED(status) else None,
        "maxRssKiB": usage.ru_maxrss,
    }

with open(sys.argv[1], "w", encoding="utf-8") as report:
    json.dump(result, report)
