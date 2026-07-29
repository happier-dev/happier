import { extractShellCommand, formatPermissionRequestSummary } from '@happier-dev/protocol';
import React, { useRef, useState } from 'react';
import { View, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { sessionAbort, sessionAllow, sessionAllowWithPermissionUpdates, sessionDeny } from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { getPermissionFooterCopy } from '@/agents/catalog/permissionUiCopy';
import { getAgentBehavior } from '@/agents/catalog/catalog';
import { parseParenIdentifier } from '@/components/tools/normalization/parse/parseParenIdentifier';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import {
    recordPermissionActionFailure,
    type PermissionActionFailureKind,
    type PermissionActionFailureState,
} from './permissionActionFailure';


interface PermissionFooterProps {
    permission: {
        id: string;
        status: "pending" | "approved" | "denied" | "canceled";
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        allowTools?: string[]; // legacy alias
        decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        suggestions?: unknown;
    };
    sessionId: string;
    toolName: string;
    toolInput?: any;
    metadata?: any;
    canApprovePermissions?: boolean;
    disabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    embedded?: boolean;
    alignFirstButtonToStart?: boolean;
}

type PermissionRequestIdentity = Readonly<{
    sessionId: string;
    permissionId: string;
}>;

type PermissionActionInFlight = Readonly<{
    requestIdentity: PermissionRequestIdentity;
    token: symbol;
}>;

type PermissionActionFailureDisplay = Readonly<{
    requestIdentity: PermissionRequestIdentity;
    failure: PermissionActionFailureState;
}>;

function isSamePermissionRequest(
    left: PermissionRequestIdentity | null,
    right: PermissionRequestIdentity,
): boolean {
    return left !== null
        && left.sessionId === right.sessionId
        && left.permissionId === right.permissionId;
}

const BUTTON_HORIZONTAL_PADDING = 10;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        justifyContent: 'center',
        gap: 10,
    },
    containerEmbedded: {
        paddingHorizontal: 0,
        paddingVertical: 0,
    },
    containerStandalone: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    buttonContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 6,
    },
    button: {
        paddingHorizontal: BUTTON_HORIZONTAL_PADDING,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: 'transparent',
        borderLeftWidth: 3,
        borderLeftColor: 'transparent',
        flexShrink: 1,
        maxWidth: '100%',
    },
    buttonAlignedToStart: {
        paddingLeft: 0,
    },
    buttonAllow: {
        backgroundColor: 'transparent',
    },
    buttonDeny: {
        backgroundColor: 'transparent',
    },
    buttonAllowAll: {
        backgroundColor: 'transparent',
    },
    buttonSelected: {
        backgroundColor: 'transparent',
        borderLeftColor: theme.colors.permissionButton.selected.border,
    },
    buttonInactive: {
        opacity: 0.3,
    },
    buttonContent: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minHeight: 18,
        flexShrink: 1,
    },
    icon: {
        marginRight: 2,
    },
    buttonText: {
        fontSize: 13,
        fontWeight: '400',
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    buttonTextAllow: {
        color: theme.colors.permissionButton.allow.text,
        fontWeight: '500',
    },
    buttonTextDeny: {
        color: theme.colors.permissionButton.deny.text,
        fontWeight: '500',
    },
    buttonTextAllowAll: {
        color: theme.colors.permissionButton.allowAll.text,
        fontWeight: '500',
    },
    buttonTextSelected: {
        color: theme.colors.permissionButton.selected.text,
        fontWeight: '500',
    },
    buttonForSession: {
        backgroundColor: 'transparent',
    },
    buttonTextForSession: {
        color: theme.colors.permissionButton.allowAll.text,
        fontWeight: '500',
    },
    buttonTextAllowRule: {
        color: theme.colors.permissionButton.allow.text,
        fontWeight: '500',
    },
    loadingIndicatorAllow: {
        color: theme.colors.permissionButton.allow.text,
    },
    loadingIndicatorDeny: {
        color: theme.colors.permissionButton.deny.text,
    },
    loadingIndicatorAllowAll: {
        color: theme.colors.permissionButton.allowAll.text,
    },
    loadingIndicatorForSession: {
        color: theme.colors.permissionButton.allowAll.text,
    },
    loadingIndicatorAllowRule: {
        color: theme.colors.permissionButton.allow.text,
    },
    actionError: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.state.danger.border,
        backgroundColor: theme.colors.state.danger.background,
    },
    actionErrorText: {
        color: theme.colors.state.danger.foreground,
        fontSize: 12,
        flexShrink: 1,
    },
    iconApproved: {
        color: theme.colors.permissionButton.allow.text,
    },
    iconDenied: {
        color: theme.colors.permissionButton.deny.text,
    },
}));

export const PermissionFooter: React.FC<PermissionFooterProps> = ({
    permission,
    sessionId,
    toolName,
    toolInput,
    metadata,
    canApprovePermissions = true,
    disabledReason,
    embedded = false,
    alignFirstButtonToStart = false,
}) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const minimumInteractiveTargetStyle = {
        minWidth: minimumInteractiveTargetSize,
        minHeight: minimumInteractiveTargetSize,
    };
    const alignedButtonStyle = alignFirstButtonToStart ? styles.buttonAlignedToStart : null;
    const requestIdentity: PermissionRequestIdentity = {
        sessionId,
        permissionId: permission.id,
    };
    const [loadingRequestIdentity, setLoadingRequestIdentity] = useState<PermissionRequestIdentity | null>(null);
    const [storedLoadingButton, setLoadingButton] = useState<'allow' | 'deny' | 'abort' | null>(null);
    const [storedLoadingAllEdits, setLoadingAllEdits] = useState(false);
    const [storedLoadingForSession, setLoadingForSession] = useState(false);
    const [storedLoadingForSessionPrefix, setLoadingForSessionPrefix] = useState(false);
    const [storedLoadingForSessionCommandName, setLoadingForSessionCommandName] = useState(false);
    const [storedLoadingExecPolicy, setLoadingExecPolicy] = useState(false);
    const [storedActionFailure, setStoredActionFailure] = useState<PermissionActionFailureDisplay | null>(null);
    const permissionActionInFlight = useRef<PermissionActionInFlight | null>(null);
    const isMounted = useRef(true);
    const isCurrentRequestLoading = isSamePermissionRequest(loadingRequestIdentity, requestIdentity);
    const loadingButton = isCurrentRequestLoading ? storedLoadingButton : null;
    const loadingAllEdits = isCurrentRequestLoading && storedLoadingAllEdits;
    const loadingForSession = isCurrentRequestLoading && storedLoadingForSession;
    const loadingForSessionPrefix = isCurrentRequestLoading && storedLoadingForSessionPrefix;
    const loadingForSessionCommandName = isCurrentRequestLoading && storedLoadingForSessionCommandName;
    const loadingExecPolicy = isCurrentRequestLoading && storedLoadingExecPolicy;
    const actionFailure = isSamePermissionRequest(storedActionFailure?.requestIdentity ?? null, requestIdentity)
        ? storedActionFailure?.failure ?? null
        : null;

    React.useEffect(() => {
        isMounted.current = true;
        return () => {
            isMounted.current = false;
        };
    }, []);
    
    const agentId = resolveAgentIdForPermissionUi({ metadata, flavor: metadata?.flavor, toolName });
    const copy = getPermissionFooterCopy(agentId);
    const permissionFooterBehavior = getAgentBehavior(agentId).permissions?.footer;
    const isCodexDecision = copy.protocol === 'codexDecision';
    const shouldUsePermissionUpdates = permissionFooterBehavior?.usePermissionUpdates === true || Array.isArray(permission?.suggestions);
    const shouldForceReadOnlyAfterStop = permissionFooterBehavior?.forceReadOnlyAfterStop === true;
    const execPolicyCommand = (() => {
        const proposedAmendment = toolInput?.proposedExecpolicyAmendment ?? toolInput?.proposed_execpolicy_amendment;
        if (Array.isArray(proposedAmendment)) {
            return proposedAmendment.filter((part: unknown): part is string => typeof part === 'string' && part.length > 0);
        }
        return [];
    })();
    const canApproveExecPolicy = permissionFooterBehavior?.supportsExecPolicyAmendment === true && execPolicyCommand.length > 0;
    const shouldHandleStopWithoutSessionAbort = permissionFooterBehavior?.stopHandling === 'denyOnly';

    if (disabledReason === 'inactive') {
        return null;
    }

    if (!canApprovePermissions && permission.status === 'pending') {
        const summary = formatPermissionRequestSummary({ toolName, toolInput });
        const disabledMessage =
            disabledReason === 'public'
                ? t('session.sharing.permissionApprovalsDisabledPublic')
                : disabledReason === 'readOnly'
                    ? t('session.sharing.permissionApprovalsDisabledReadOnly')
                    : t('session.sharing.permissionApprovalsDisabledNotGranted');
        return (
            <View style={{ marginTop: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                <View style={{
                    backgroundColor: theme.colors.surface.elevated,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    padding: 12,
                    gap: 6,
                }}>
                    <Text style={{ color: theme.colors.text.primary, fontWeight: '600' }}>
                        {t('session.sharing.permissionApprovalsDisabledTitle')}
                    </Text>
                    <Text style={{ color: theme.colors.text.secondary }}>
                        {disabledMessage}
                    </Text>
                    <Text style={{ color: theme.colors.text.secondary, fontSize: 12 }}>
                        {summary}
                    </Text>
                </View>
            </View>
        );
    }

    const runPermissionAction = async (
        action: PermissionActionFailureKind,
        setLoading: (loading: boolean) => void,
        operation: () => Promise<void>,
    ) => {
        if (isSamePermissionRequest(permissionActionInFlight.current?.requestIdentity ?? null, requestIdentity)) {
            return;
        }
        const token = Symbol(action);
        permissionActionInFlight.current = {
            requestIdentity,
            token,
        };
        setStoredActionFailure(null);
        setLoadingButton(null);
        setLoadingAllEdits(false);
        setLoadingForSession(false);
        setLoadingForSessionPrefix(false);
        setLoadingForSessionCommandName(false);
        setLoadingExecPolicy(false);
        setLoadingRequestIdentity(requestIdentity);
        setLoading(true);
        try {
            await operation();
        } catch (error) {
            if (isMounted.current && permissionActionInFlight.current?.token === token) {
                setStoredActionFailure((previousDisplay) => ({
                    requestIdentity,
                    failure: recordPermissionActionFailure(
                        action,
                        error,
                        isSamePermissionRequest(previousDisplay?.requestIdentity ?? null, requestIdentity)
                            ? previousDisplay?.failure ?? null
                            : null,
                    ),
                }));
            } else {
                // The request can be replaced or the footer can unmount while its RPC is pending.
                // Keep the sanitized operational record, but do not project stale failure UI.
                recordPermissionActionFailure(action, error, null);
            }
        } finally {
            if (permissionActionInFlight.current?.token === token) {
                permissionActionInFlight.current = null;
                if (isMounted.current) {
                    setLoading(false);
                    setLoadingRequestIdentity((currentIdentity) =>
                        isSamePermissionRequest(currentIdentity, requestIdentity) ? null : currentIdentity
                    );
                }
            }
        }
    };

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        await runPermissionAction('approve', (loading) => setLoadingButton(loading ? 'allow' : null), async () => {
            await sessionAllow(sessionId, permission.id);
        });
    };

    const handleApproveAllEdits = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        await runPermissionAction('approve_all_edits', setLoadingAllEdits, async () => {
            if (shouldUsePermissionUpdates) {
                await sessionAllowWithPermissionUpdates(sessionId, permission.id, {
                    mode: 'acceptEdits',
                    updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                });
            } else {
                await sessionAllow(sessionId, permission.id, 'acceptEdits');
            }
            // Update the session permission mode to 'acceptEdits' for future permissions
            storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
        });
    };

    const handleApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || !toolName) return;

        await runPermissionAction('approve_for_session', setLoadingForSession, async () => {
            let toolIdentifier = toolName;
            if (shouldUsePermissionUpdates) {
                const parsed = parseParenIdentifier(toolIdentifier);
                const rules = [
                    parsed
                        ? { toolName: parsed.name, ...(parsed.spec ? { ruleContent: parsed.spec } : {}) }
                        : { toolName: toolIdentifier },
                ];
                await sessionAllowWithPermissionUpdates(sessionId, permission.id, {
                    allowedTools: [toolIdentifier],
                    updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }],
                });
            } else {
                await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
            }
        });
    };

    const handleApproveForSessionSubcommand = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        const stripped = stripSimpleEnvPrelude(command);
        const parts = stripped.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        const canUseSubcommand =
            Boolean(cmd) &&
            Boolean(sub) &&
            !sub.startsWith('-') &&
            // Only offer subcommand-level approvals for common subcommand CLIs.
            ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd);
        if (!canUseSubcommand) return;

        await runPermissionAction('approve_for_session_subcommand', setLoadingForSessionPrefix, async () => {
            const toolIdentifier = `${toolName}(${cmd} ${sub}:*)`;
            if (shouldUsePermissionUpdates) {
                const parsed = parseParenIdentifier(toolIdentifier);
                const rules = [
                    parsed
                        ? { toolName: parsed.name, ...(parsed.spec ? { ruleContent: parsed.spec } : {}) }
                        : { toolName: toolIdentifier },
                ];
                await sessionAllowWithPermissionUpdates(sessionId, permission.id, {
                    allowedTools: [toolIdentifier],
                    updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }],
                });
            } else {
                await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
            }
        });
    };

    const handleApproveForSessionCommandName = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        const stripped = stripSimpleEnvPrelude(command);
        const first = stripped.split(/\s+/).filter(Boolean)[0];
        if (!first) return;

        await runPermissionAction('approve_for_session_command', setLoadingForSessionCommandName, async () => {
            const toolIdentifier = `${toolName}(${first}:*)`;
            if (shouldUsePermissionUpdates) {
                const parsed = parseParenIdentifier(toolIdentifier);
                const rules = [
                    parsed
                        ? { toolName: parsed.name, ...(parsed.spec ? { ruleContent: parsed.spec } : {}) }
                        : { toolName: toolIdentifier },
                ];
                await sessionAllowWithPermissionUpdates(sessionId, permission.id, {
                    allowedTools: [toolIdentifier],
                    updatedPermissions: [{ type: 'addRules', rules, behavior: 'allow', destination: 'session' }],
                });
            } else {
                await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
            }
        });
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        await runPermissionAction('deny', (loading) => setLoadingButton(loading ? 'deny' : null), async () => {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'denied');
        });
    };

    const handleStop = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        await runPermissionAction('stop', (loading) => setLoadingButton(loading ? 'abort' : null), async () => {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'abort');
            // Denying a single tool call is not always enough to stop the agent from continuing.
            // Also abort the current session run so the agent stops and waits for the user.
            await sessionAbort(sessionId);
            if (shouldForceReadOnlyAfterStop) {
                storage.getState().updateSessionPermissionMode(sessionId, 'read-only');
            }
        });
    };
    
    const handleDecisionApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        await runPermissionAction('approve', (loading) => setLoadingButton(loading ? 'allow' : null), async () => {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved');
        });
    };
    
    const handleDecisionApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        await runPermissionAction('approve_for_session', setLoadingForSession, async () => {
            await sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session');
        });
    };

    const handleDecisionApproveExecPolicy = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy || !canApproveExecPolicy) return;

        await runPermissionAction('approve_execpolicy', setLoadingExecPolicy, async () => {
            await sessionAllow(
                sessionId,
                permission.id,
                undefined,
                undefined,
                'approved_execpolicy_amendment',
                { command: execPolicyCommand }
            );
        });
    };
    
    const handleDecisionDenyWithoutSessionAbort = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        await runPermissionAction('stop', (loading) => setLoadingButton(loading ? 'abort' : null), async () => {
            await sessionDeny(sessionId, permission.id, undefined, undefined, 'denied');
        });
    };

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';
    const isStopped = isDenied && permission.decision === 'abort';
    const isDeniedViaNo = isDenied && !isStopped;

    // Helper function to check if tool matches allowed pattern
    const getAllowedToolsList = (permission: any): string[] | undefined => {
        const list = permission?.allowedTools ?? permission?.allowTools;
        return Array.isArray(list) ? list : undefined;
    };

    const shellToolNames = new Set(['bash', 'execute', 'shell']);

    const stripSimpleEnvPrelude = (command: string): string => {
        const stripLeadingEnvAssignments = (input: string): string => {
            const parts = input.trim().split(/\s+/);
            let i = 0;
            while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) {
                i++;
            }
            return parts.slice(i).join(' ');
        };

        const stripLeadingUnsetPrelude = (input: string): string => {
            const trimmed = input.trimStart();
            if (!trimmed.startsWith('unset ')) return input;
            // Only strip a simple "unset VAR VAR2; <cmd>" prelude. If there is no semicolon,
            // or if it looks like a real unset invocation (flags/assignments), keep it.
            const match = trimmed.match(/^unset(?:\s+[A-Za-z_][A-Za-z0-9_]*)+\s*;\s*/);
            if (!match) return input;
            return trimmed.slice(match[0].length);
        };

        let out = command.trim();
        // Claude (and some shells) prepend env assignment and/or env-unset preludes; strip them
        // for "effective command" purposes (allowlisting/prefix matching + button labels).
        for (let i = 0; i < 3; i++) {
            const next = stripLeadingUnsetPrelude(stripLeadingEnvAssignments(out)).trim();
            if (next === out) break;
            out = next;
        }
        return out;
    };

    const matchesPrefix = (command: string, prefix: string): boolean => {
        if (!command || !prefix) return false;
        if (!command.startsWith(prefix)) return false;
        if (command.length === prefix.length) return true;
        if (prefix.endsWith(' ')) return true;
        return command[prefix.length] === ' ';
    };

    const isToolAllowed = (toolName: string, toolInput: any, allowedTools: string[] | undefined): boolean => {
        if (!allowedTools) return false;
        
        // Direct match for non-Bash tools
        if (allowedTools.includes(toolName)) return true;
        
        // For shell/exec tools, check exact command match
        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (command && shellToolNames.has(lower)) {
            const exact = `${toolName}(${command})`;
            if (allowedTools.includes(exact)) return true;

            // Also accept prefixes (e.g. `Bash(git status:*)`) and shell-tool synonyms.
            const effectiveCommand = stripSimpleEnvPrelude(command);
            for (const item of allowedTools) {
                if (typeof item !== 'string') continue;
                const parsed = parseParenIdentifier(item);
                if (!parsed) continue;
                if (!shellToolNames.has(parsed.name.toLowerCase())) continue;

                const spec = parsed.spec;
                if (spec.endsWith(':*')) {
                    const prefix = spec.slice(0, -2);
                    if (prefix && matchesPrefix(effectiveCommand, prefix)) return true;
                } else if (spec === command) {
                    return true;
                }
            }
        }
        
        return false;
    };

    // Detect which button was used based on mode (for Claude) or decision (for Codex)
    const allowedTools = getAllowedToolsList(permission);
    const commandForShell = extractShellCommand(toolInput);
    const isShellTool = shellToolNames.has(toolName.toLowerCase());

    const isApprovedForSessionSubcommand = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        const effectiveCommand = stripSimpleEnvPrelude(commandForShell);
        const parts = effectiveCommand.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        if (!cmd || !sub) return false;
        if (sub.startsWith('-')) return false;
        if (!['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd)) return false;

        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            const spec = parsed.spec;
            if (spec.endsWith(':*')) {
                const prefix = spec.slice(0, -2);
                if (prefix && matchesPrefix(effectiveCommand, prefix) && prefix.trim() === `${cmd} ${sub}`) return true;
            }
        }
        return false;
    })();

    const isApprovedForSessionExact = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            if (!parsed.spec.endsWith(':*') && parsed.spec === commandForShell) return true;
        }
        return false;
    })();

    const isApprovedForSessionToolWide = (() => {
        if (!isApproved || !allowedTools || !isShellTool) return false;
        return allowedTools.some((item) => typeof item === 'string' && item.toLowerCase() === toolName.toLowerCase());
    })();

    const isApprovedForSessionCommandName = (() => {
        if (!isApproved || !allowedTools || !isShellTool || !commandForShell) return false;
        const effective = stripSimpleEnvPrelude(commandForShell);
        const first = effective.split(/\s+/).filter(Boolean)[0];
        if (!first) return false;
        for (const item of allowedTools) {
            if (typeof item !== 'string') continue;
            const parsed = parseParenIdentifier(item);
            if (!parsed) continue;
            if (!shellToolNames.has(parsed.name.toLowerCase())) continue;
            if (parsed.spec === `${first}:*`) return true;
        }
        return false;
    })();

    const isApprovedForSession = isApproved && (
        isShellTool
            ? (isApprovedForSessionToolWide || isApprovedForSessionExact || isApprovedForSessionSubcommand || isApprovedForSessionCommandName)
            : isToolAllowed(toolName, toolInput, allowedTools)
    );

    const isApprovedViaAllow = isApproved && permission.mode !== 'acceptEdits' && !isApprovedForSession;
    const isApprovedViaAllEdits = isApproved && permission.mode === 'acceptEdits';
    
    // Decision-protocol status detection with fallback
    const isCodexApproved = isCodexDecision && isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isCodexDecision && isApproved && permission.decision === 'approved_for_session';
    const isCodexApprovedExecPolicy = isCodexDecision && isApproved && permission.decision === 'approved_execpolicy_amendment';
    const isCodexAborted = isCodexDecision && isDenied && permission.decision === 'abort';
    const actionFailureNode = actionFailure && isPending ? (
        <View
            testID="permission-footer.action-error"
            accessibilityRole="alert"
            style={styles.actionError}
        >
            <Ionicons name="alert-circle-outline" size={14} color={theme.colors.state.danger.foreground} />
            <Text style={styles.actionErrorText}>
                {t('errors.operationFailed')} {t('errors.tryAgain')}
            </Text>
        </View>
    ) : null;

    // Render Codex-style decision buttons if the agent uses the Codex decision protocol.
    if (copy.protocol === 'codexDecision') {
        const actionsDisabled = !isPending || loadingButton !== null || loadingForSession || loadingExecPolicy;
        return (
            <View style={[styles.container, embedded ? styles.containerEmbedded : styles.containerStandalone]}>
                <View style={styles.buttonContainer}>
                    {/* Decision protocol: Yes button */}
                    <TouchableOpacity
                        testID="permission-footer.allow"
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: actionsDisabled,
                            selected: isCodexApproved,
                            busy: loadingButton === 'allow',
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonAllow,
                            isCodexApproved && styles.buttonSelected,
                            (isCodexAborted || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleDecisionApprove}
                        disabled={actionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'allow' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllow.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllow,
                                    isCodexApproved && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('common.yes')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Decision protocol: Yes, always allow this command button */}
                    {canApproveExecPolicy && (
                        <TouchableOpacity
                            testID="permission-footer.allow-execpolicy"
                            accessibilityRole="button"
                            accessibilityState={{
                                disabled: actionsDisabled,
                                selected: isCodexApprovedExecPolicy,
                                busy: loadingExecPolicy,
                            }}
                            style={[
                                styles.button,
                                minimumInteractiveTargetStyle,
                                alignedButtonStyle,
                                isPending && styles.buttonForSession,
                                isCodexApprovedExecPolicy && styles.buttonSelected,
                                (isCodexAborted || isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                            ]}
                            onPress={handleDecisionApproveExecPolicy}
                            disabled={actionsDisabled}
                            activeOpacity={isPending ? 0.7 : 1}
                        >
                            {loadingExecPolicy && isPending ? (
                                <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                    <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorForSession.color} />
                                </View>
                            ) : (
                                <View style={styles.buttonContent}>
                                    <Text style={[
                                        styles.buttonText,
                                        isPending && styles.buttonTextForSession,
                                        isCodexApprovedExecPolicy && styles.buttonTextSelected
                                    ]} numberOfLines={1} ellipsizeMode="tail">
                                        {t(copy.yesAlwaysAllowCommandKey)}
                                    </Text>
                                </View>
                            )}
                        </TouchableOpacity>
                    )}

                    {/* Decision protocol: Yes, and don't ask for a session button */}
                    <TouchableOpacity
                        testID="permission-footer.allow-for-session"
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: actionsDisabled,
                            selected: isCodexApprovedForSession,
                            busy: loadingForSession,
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleDecisionApproveForSession}
                        disabled={actionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllowRule.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowRule,
                                    isCodexApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesForSessionKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        testID="permission-footer.deny"
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: actionsDisabled,
                            selected: isDeniedViaNo,
                            busy: loadingButton === 'deny',
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonDeny,
                            isDeniedViaNo && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive,
                        ]}
                        onPress={handleDeny}
                        disabled={actionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'deny' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorDeny.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text
                                    style={[
                                        styles.buttonText,
                                        isPending && styles.buttonTextDeny,
                                        isDeniedViaNo && styles.buttonTextSelected,
                                    ]}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                >
                                    {t('common.no')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Decision-protocol providers can customize stop handling through registry behavior. */}
                    <TouchableOpacity
                        testID="permission-footer.stop"
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: actionsDisabled,
                            selected: isCodexAborted,
                            busy: loadingButton === 'abort',
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonDeny,
                            isCodexAborted && styles.buttonSelected,
                            (isCodexApproved || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={shouldHandleStopWithoutSessionAbort ? handleDecisionDenyWithoutSessionAbort : handleStop}
                        disabled={actionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingButton === 'abort' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorDeny.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextDeny,
                                    isCodexAborted && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.stopKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
                {actionFailureNode}
            </View>
        );
    }

    // Render rule-update buttons for the non-decision protocol.
    const showAllowForSessionSubcommand = isShellTool && typeof commandForShell === 'string' && (() => {
        const stripped = stripSimpleEnvPrelude(String(commandForShell));
        const parts = stripped.split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        return Boolean(cmd) && Boolean(sub) && !String(sub).startsWith('-') && ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(String(cmd));
    })();
    const showAllowForSessionCommandName = isShellTool && typeof commandForShell === 'string' && commandForShell.length > 0 && Boolean(stripSimpleEnvPrelude(String(commandForShell)).split(/\s+/).filter(Boolean)[0]);
    const primaryActionsDisabled = !isPending || loadingButton !== null || loadingAllEdits || loadingForSession;
    const ruleActionsDisabled = primaryActionsDisabled || loadingForSessionPrefix || loadingForSessionCommandName;
    return (
        <View style={[styles.container, embedded ? styles.containerEmbedded : styles.containerStandalone]}>
            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    testID="permission-footer.allow"
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: primaryActionsDisabled,
                        selected: isApprovedViaAllow,
                        busy: loadingButton === 'allow',
                    }}
                    style={[
                        styles.button,
                        minimumInteractiveTargetStyle,
                        alignedButtonStyle,
                        isPending && styles.buttonAllow,
                        isApprovedViaAllow && styles.buttonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={primaryActionsDisabled}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'allow' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllow.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextAllow,
                                isApprovedViaAllow && styles.buttonTextSelected
                            ]} numberOfLines={1} ellipsizeMode="tail">
                                {t('common.yes')}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>

                {/* Allow All Edits button - only show for edit/write tools */}
                {(toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit') && (
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: primaryActionsDisabled,
                            selected: isApprovedViaAllEdits,
                            busy: loadingAllEdits,
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={primaryActionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingAllEdits && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllowAll.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowAll,
                                    isApprovedViaAllEdits && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesAllowAllEditsKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow for session button - only show for non-edit, non-exit-plan tools */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && (
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: ruleActionsDisabled,
                            selected: isShellTool ? isApprovedForSessionToolWide : isApprovedForSession,
                            busy: loadingForSession,
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            ((isShellTool ? isApprovedForSessionToolWide : isApprovedForSession) && styles.buttonSelected),
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSession}
                        disabled={ruleActionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSession && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllowRule.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowRule,
                                    (isShellTool ? isApprovedForSessionToolWide : isApprovedForSession) && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t(copy.yesForToolKey)}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow subcommand for session (shell tools only) */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && showAllowForSessionSubcommand && (
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: ruleActionsDisabled,
                            selected: isApprovedForSessionSubcommand && !isApprovedForSessionCommandName,
                            busy: loadingForSessionPrefix,
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            (isApprovedForSessionSubcommand && !isApprovedForSessionCommandName) && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSessionToolWide || isApprovedForSessionExact) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionSubcommand}
                        disabled={ruleActionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSessionPrefix && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllowRule.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowRule,
                                    (isApprovedForSessionSubcommand && !isApprovedForSessionCommandName) && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {(() => {
                                        const stripped = stripSimpleEnvPrelude(String(commandForShell));
                                        const parts = stripped.split(/\s+/).filter(Boolean);
                                        const cmd = parts[0] ?? '';
                                        const sub = parts[1] ?? '';
                                        return `${t('claude.permissions.yesForSubcommand')}${cmd && sub ? ` (${cmd} ${sub})` : ''}`;
                                    })()}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow command name for session (shell tools only) */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && showAllowForSessionCommandName && (
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{
                            disabled: ruleActionsDisabled,
                            selected: isApprovedForSessionCommandName,
                            busy: loadingForSessionCommandName,
                        }}
                        style={[
                            styles.button,
                            minimumInteractiveTargetStyle,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            isApprovedForSessionCommandName && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSessionToolWide || isApprovedForSessionExact || isApprovedForSessionSubcommand) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionCommandName}
                        disabled={ruleActionsDisabled}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {loadingForSessionCommandName && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorAllowRule.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowRule,
                                    isApprovedForSessionCommandName && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesForCommandName')}{typeof commandForShell === 'string' ? ` (${stripSimpleEnvPrelude(commandForShell).split(/\s+/).filter(Boolean)[0] ?? ''})` : ''}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    testID="permission-footer.deny"
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: primaryActionsDisabled,
                        selected: isDeniedViaNo,
                        busy: loadingButton === 'deny',
                    }}
                    style={[
                        styles.button,
                        minimumInteractiveTargetStyle,
                        alignedButtonStyle,
                        isPending && styles.buttonDeny,
                        isDeniedViaNo && styles.buttonSelected,
                        (isApproved || isStopped) && styles.buttonInactive,
                    ]}
                    onPress={handleDeny}
                    disabled={primaryActionsDisabled}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'deny' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorDeny.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text
                                style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextDeny,
                                    isDeniedViaNo && styles.buttonTextSelected,
                                ]}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {t('common.no')}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>

                <TouchableOpacity
                    testID="permission-footer.stop"
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: primaryActionsDisabled,
                        selected: isStopped,
                        busy: loadingButton === 'abort',
                    }}
                    style={[
                        styles.button,
                        minimumInteractiveTargetStyle,
                        alignedButtonStyle,
                        isPending && styles.buttonDeny,
                        isStopped && styles.buttonSelected,
                        (isApproved || isDeniedViaNo) && styles.buttonInactive,
                    ]}
                    onPress={handleStop}
                    disabled={primaryActionsDisabled}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {loadingButton === 'abort' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivitySpinner size={Platform.OS === 'ios' ? "small" : 14} color={styles.loadingIndicatorDeny.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text
                                style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextDeny,
                                    isStopped && styles.buttonTextSelected,
                                ]}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                            >
                                {t(copy.stopKey)}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>
            </View>
            {actionFailureNode}
        </View>
    );
};
