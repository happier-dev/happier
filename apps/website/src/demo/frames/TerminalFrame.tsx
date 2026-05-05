import { motion, AnimatePresence } from 'framer-motion';
import type {
    TerminalCastDescriptor,
    TerminalLine,
    TerminalTypingPrompt,
} from '../timeline/scenarioTypes';
import { TypewriterTerminalPrompt } from './TypewriterTerminalPrompt';
import { CastPlayer } from './CastPlayer';
import { cn } from '@/utils/cn';

type Props = {
    lines: TerminalLine[];
    commands?: readonly string[];
    /**
     * When present, replaces the command rail with a live typing animation
     * cycling through tokens (e.g. `happier claude` → `happier codex` → …).
     */
    typingPrompt?: TerminalTypingPrompt;
    /**
     * When present, replays a real asciinema recording of an actual
     * `hdev claude` / `hdev codex` / `hdev opencode` run via xterm.js.
     * Takes precedence over `lines` and `typingPrompt`: the synthetic
     * line-based renderer is for caption-flash / sync-pulse beats; the
     * cast renderer is for the moments where the user is meant to read
     * what the agent is actually doing.
     */
    cast?: TerminalCastDescriptor;
    /** Used as the replay key so the typewriter restarts on beat change. */
    replayKey?: string | number;
    /** Show blinking prompt cursor at end of output. */
    cursor?: boolean;
    /**
     * When true, `permission`-kind lines pulse an accent-orange glow in a
     * continuous loop matching the phone's permission card. This is the
     * "breathing together" cue that makes it obvious the two devices are
     * seeing the same pending request.
     */
    pendingPermissionActive?: boolean;
};

const accentClass: Record<NonNullable<TerminalLine['accent']>, string> = {
    green: 'text-[color:var(--accent-green)]',
    orange: 'text-[color:var(--accent-orange)]',
    red: 'text-[color:var(--accent-red)]',
    blue: 'text-[color:var(--accent-blue)]',
    purple: 'text-[color:var(--accent-purple)]',
    dim: 'text-[color:var(--fg-tertiary)]',
};

/**
 * Terminal content, rendered to look like the real Claude Code TUI
 * running through `happier claude`. Colors match theme.ts accent palette.
 *
 * Future: replace with an asciinema-player embed playing back real
 * recordings of `happier claude` runs. This component's interface
 * stays the same; only the renderer changes.
 */
export function createTerminalCommandRail(commands: readonly string[]): string | null {
    if (commands.length === 0) return null;
    return commands.join(' → ');
}

export function TerminalBody({
    lines,
    commands = [],
    typingPrompt,
    cast,
    replayKey,
    cursor = true,
    pendingPermissionActive = false,
}: Props) {
    if (cast) {
        // The cast renderer takes the full terminal area: xterm needs an
        // unframed grid to lay out its character cells correctly.
        return (
            <div
                className="min-h-[220px] h-full"
                style={{ background: 'var(--terminal-bg)' }}
            >
                <CastPlayer
                    src={cast.src}
                    replayKey={replayKey}
                    speed={cast.speed}
                    startAtSeconds={cast.startAtSeconds}
                    endAtSeconds={cast.endAtSeconds}
                />
            </div>
        );
    }

    const commandRail = !typingPrompt ? createTerminalCommandRail(commands) : null;

    return (
        <div
            className={cn(
                'font-mono text-[12.5px] leading-[1.55]',
                'min-h-[220px] px-5 py-4',
            )}
            style={{ background: 'var(--terminal-bg)', color: 'var(--terminal-text)' }}
        >
            {typingPrompt ? (
                <TypewriterTerminalPrompt prompt={typingPrompt} replayKey={replayKey} />
            ) : commandRail ? (
                <div
                    className="mb-3 inline-block rounded-full border px-3 py-1 text-[11px]"
                    style={{
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--border-subtle)',
                        color: 'var(--fg-tertiary)',
                    }}
                >
                    {commandRail}
                </div>
            ) : null}
            <AnimatePresence initial={false}>
                {lines.map((line, i) => {
                    const color = line.accent ? accentClass[line.accent] : undefined;
                    const shouldPulse =
                        pendingPermissionActive && line.kind === 'permission';
                    return (
                        <motion.div
                            key={`${i}-${line.text}`}
                            initial={{ opacity: 0, y: 6 }}
                            animate={
                                shouldPulse
                                    ? {
                                          opacity: 1,
                                          y: 0,
                                          // Same keyframes as PermissionCard so both devices breathe in lockstep.
                                          boxShadow: [
                                              '0 0 0 rgba(255,159,10,0)',
                                              '0 0 0 4px rgba(255,159,10,0.22)',
                                              '0 0 0 rgba(255,159,10,0)',
                                          ],
                                      }
                                    : { opacity: 1, y: 0 }
                            }
                            transition={
                                shouldPulse
                                    ? {
                                          opacity: { duration: 0.25 },
                                          y: { duration: 0.25 },
                                          boxShadow: {
                                              duration: 1.2,
                                              repeat: Infinity,
                                              ease: 'easeInOut',
                                          },
                                      }
                                    : {
                                          duration: 0.25,
                                          ease: [0.2, 0, 0, 1],
                                          delay: Math.min(i * 0.03, 0.3),
                                      }
                            }
                            className={cn(
                                'whitespace-pre-wrap break-words',
                                color,
                                shouldPulse &&
                                    '-mx-2 rounded-[6px] px-2 py-[2px]',
                            )}
                            style={
                                shouldPulse
                                    ? {
                                          background:
                                              'color-mix(in srgb, var(--accent-orange) 8%, transparent)',
                                      }
                                    : undefined
                            }
                        >
                            {renderPrefix(line.kind)}
                            <span>{line.text}</span>
                        </motion.div>
                    );
                })}
            </AnimatePresence>
            {cursor && !typingPrompt && (
                <span className="terminal-cursor" aria-hidden />
            )}
        </div>
    );
}

function renderPrefix(kind: TerminalLine['kind']) {
    switch (kind) {
        case 'user':
            return <span style={{ color: 'var(--accent-green)' }}>✓ </span>;
        case 'permission':
            return <span style={{ color: 'var(--accent-orange)' }}>⚑ </span>;
        case 'tool':
            return <span style={{ color: 'var(--accent-blue)' }}>› </span>;
        case 'info':
            return <span style={{ color: 'var(--fg-tertiary)' }}>· </span>;
        case 'agent':
            return <span style={{ color: 'var(--fg-secondary)' }}>◆ </span>;
        case 'prompt':
        default:
            return null;
    }
}
