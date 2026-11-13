Linux fixtures were captured read-only on 2026-11-13 from the lane's Linux host:
`/etc/crontab`, `systemctl list-timers --all --no-pager --output=json`, and
`systemctl show sysstat-collect.timer apport-autoreport.timer --property=Id,TimersCalendar,TimersMonotonic --no-pager`.
They contain native system maintenance schedules, with no user crontab contents.
The cron capture preserves its schedule columns; account names, executable content,
paths and environment values are redacted.

macOS fixtures were captured read-only on 2026-11-13 from authorized target
`mac-host`, using `plutil -convert json -o -` on the built-in launchd plists
`com.apple.bsd.dirhelper.plist` and `com.apple.newsyslog.plist` under
`/System/Library/LaunchDaemons`. Only native `Label` and
`StartCalendarInterval` fields are retained: executable paths, environment,
and unrelated launch behavior were removed for privacy. These captures contain
no usernames or hostnames. The additional calendar-array case is source-derived.

Windows cases are explicitly source-derived in the tests. The authorized
`windows2` target was not configured, so no Windows capture was available.
