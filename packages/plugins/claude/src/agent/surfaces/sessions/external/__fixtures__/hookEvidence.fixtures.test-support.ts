export const CLAUDE_HOOK_SUPPORTED_VERSION_FIXTURE = '2.1.217' as const;
export const CLAUDE_HOOK_UNSUPPORTED_VERSION_FIXTURES = Object.freeze([
    '2.1.216',
    '2.1.218',
    'unknown',
]);

export const CLAUDE_SESSION_START_FIXTURE = Object.freeze({
    hook_event_name: 'SessionStart' as const,
    session_id: 'claude-session-a',
    source: 'startup' as const,
    cwd: '/private/workspace',
    transcript_path: '/private/transcript.jsonl',
    prompt_id: 'prompt-1',
});

export const CLAUDE_NORMAL_RESUME_FIXTURES = Object.freeze([
    Object.freeze({
        hook_event_name: 'SessionStart' as const,
        session_id: 'claude-session-a',
        source: 'resume' as const,
    }),
    Object.freeze({
        hook_event_name: 'SessionStart' as const,
        session_id: 'claude-session-a',
        source: 'resume' as const,
    }),
]);

export const CLAUDE_FORK_START_FIXTURE = Object.freeze({
    hook_event_name: 'SessionStart' as const,
    session_id: 'claude-session-fork',
    source: 'startup' as const,
});

export const CLAUDE_CLEAN_STOP_FIXTURE = Object.freeze({
    hook_event_name: 'Stop' as const,
    session_id: 'claude-session-a',
    prompt_id: 'prompt-17',
    stop_hook_active: false,
});

export const CLAUDE_RECURSIVE_STOP_FIXTURE = Object.freeze({
    ...CLAUDE_CLEAN_STOP_FIXTURE,
    prompt_id: 'prompt-18',
    stop_hook_active: true,
});

// The pinned Claude contract emits no Stop event for Ctrl-C.
export const CLAUDE_CTRL_C_SEQUENCE_FIXTURE = Object.freeze([
    CLAUDE_SESSION_START_FIXTURE,
]);
