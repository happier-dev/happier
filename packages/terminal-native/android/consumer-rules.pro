# The adapter is loaded reflectively so the unavailable fallback can compile
# without Termux sources in public/unapproved artifacts.
-keep class dev.happier.terminal.termux.TermuxBackedRemoteSession {
    public <init>(java.lang.String, dev.happier.terminal.TermuxRemoteSessionCallbacks);
}

# Stable names make the release artifact evidence deterministic across R8 and
# multidex while direct adapter references keep the used implementation alive.
-keepnames class com.termux.terminal.**
-keepnames class com.termux.view.TerminalRenderer
