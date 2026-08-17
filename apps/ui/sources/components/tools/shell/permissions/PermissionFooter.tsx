import React, { useState } from 'react';
import { View, TouchableOpacity, Platform } from 'react-native';
import { sessionAbort, sessionAllow, sessionAllowWithPermissionUpdates, sessionDeny } from '@/sync/ops';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { getPermissionFooterCopy } from '@/agents/catalog/permissionUiCopy';
import { getAgentBehavior } from '@/agents/catalog/catalog';
import { extractShellCommand } from '@/components/tools/normalization/parse/shellCommand';
import { parseParenIdentifier } from '@/components/tools/normalization/parse/parseParenIdentifier';
import { formatPermissionRequestSummary } from '@/components/tools/normalization/policy/permissionSummary';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { createPermissionActionDispatchGuard } from './permissionActionDispatchGuard';
import { useHistoricalTranscriptAgentId } from '@/components/sessions/transcript/attribution/SessionTranscriptAgentAttributionContext';


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
    const historicalAgentId = useHistoricalTranscriptAgentId();
    const alignedButtonStyle = alignFirstButtonToStart ? styles.buttonAlignedToStart : null;
    const [loadingButton, setLoadingButton] = useState<'allow' | 'deny' | 'abort' | null>(null);
    const [loadingAllEdits, setLoadingAllEdits] = useState(false);
    const [loadingForSession, setLoadingForSession] = useState(false);
    const [loadingForSessionPrefix, setLoadingForSessionPrefix] = useState(false);
    const [loadingForSessionCommandName, setLoadingForSessionCommandName] = useState(false);
    const [loadingExecPolicy, setLoadingExecPolicy] = useState(false);
    const requestKey = `${sessionId}\u0000${permission.id}`;
    const actionDispatchGuardRef = React.useRef<ReturnType<typeof createPermissionActionDispatchGuard> | null>(null);
    if (actionDispatchGuardRef.current === null) {
        actionDispatchGuardRef.current = createPermissionActionDispatchGuard(requestKey);
    } else {
        actionDispatchGuardRef.current.setRequestKey(requestKey);
    }
    const actionDispatchGuard = actionDispatchGuardRef.current;
    React.useEffect(() => {
        if (permission.status !== 'pending') return;
        actionDispatchGuard.retainRequest(requestKey);
        return () => actionDispatchGuard.releaseRequest(requestKey);
    }, [actionDispatchGuard, permission.status, requestKey]);
    const dispatchPermissionAction = (action: () => Promise<void>) => (
        actionDispatchGuard.dispatch(requestKey, action)
    );
    
    // A terminal outcome was decided by whoever was running at the time, so a
    // Session that later switched Agent must not re-label its history. A
    // pending request is the opposite case: it is live, and only the current
    // Agent can answer it, so live authority is kept there deliberately.
    const liveAgentId = resolveAgentIdForPermissionUi({ flavor: metadata?.flavor, toolName });
    const agentId = permission.status === 'pending'
        ? liveAgentId
        : (historicalAgentId ?? liveAgentId);
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

    const handleApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        setLoadingButton('allow');
        try {
            await dispatchPermissionAction(() => sessionAllow(sessionId, permission.id));
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const handleApproveAllEdits = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        setLoadingAllEdits(true);
        try {
            const dispatched = await dispatchPermissionAction(async () => {
                if (shouldUsePermissionUpdates) {
                    await sessionAllowWithPermissionUpdates(sessionId, permission.id, {
                        mode: 'acceptEdits',
                        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
                    });
                } else {
                    await sessionAllow(sessionId, permission.id, 'acceptEdits');
                }
            });
            if (dispatched) {
                // Update the session permission mode to 'acceptEdits' for future permissions.
                storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
            }
        } catch (error) {
            console.error('Failed to approve all edits:', error);
        } finally {
            setLoadingAllEdits(false);
        }
    };

    const handleApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || !toolName) return;

        setLoadingForSession(true);
        try {
            await dispatchPermissionAction(async () => {
                const toolIdentifier = toolName;
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
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleApproveForSessionSubcommand = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        if (!isBroadShellGrantEligible(command)) return;
        const parts = command.trim().split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        const canUseSubcommand =
            Boolean(cmd) &&
            Boolean(sub) &&
            !sub.startsWith('-') &&
            // Only offer subcommand-level approvals for common subcommand CLIs.
            ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(cmd);
        if (!canUseSubcommand) return;

        setLoadingForSessionPrefix(true);
        try {
            const toolIdentifier = `${toolName}(${cmd} ${sub}:*)`;
            await dispatchPermissionAction(async () => {
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
        } catch (error) {
            console.error('Failed to approve subcommand for session:', error);
        } finally {
            setLoadingForSessionPrefix(false);
        }
    };

    const handleApproveForSessionCommandName = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName || !toolName) return;

        const command = extractShellCommand(toolInput);
        const lower = toolName.toLowerCase();
        if (!command || !(lower === 'bash' || lower === 'execute' || lower === 'shell')) return;

        if (!isBroadShellGrantEligible(command)) return;
        const first = command.trim().split(/\s+/).filter(Boolean)[0];
        if (!first) return;

        setLoadingForSessionCommandName(true);
        try {
            const toolIdentifier = `${toolName}(${first}:*)`;
            await dispatchPermissionAction(async () => {
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
        } catch (error) {
            console.error('Failed to approve command name for session:', error);
        } finally {
            setLoadingForSessionCommandName(false);
        }
    };

    const handleDeny = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        setLoadingButton('deny');
        try {
            await dispatchPermissionAction(() => sessionDeny(sessionId, permission.id, undefined, undefined, 'denied'));
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };

    const handleStop = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingAllEdits || loadingForSession) return;

        setLoadingButton('abort');
        try {
            const dispatched = await dispatchPermissionAction(() => (
                sessionDeny(sessionId, permission.id, undefined, undefined, 'abort')
            ));
            if (!dispatched) return;
            // Denying a single tool call is not always enough to stop the agent from continuing.
            // Also abort the current session run so the agent stops and waits for the user.
            await sessionAbort(sessionId);
            if (shouldForceReadOnlyAfterStop) {
                storage.getState().updateSessionPermissionMode(sessionId, 'read-only');
            }
        } catch (error) {
            console.error('Failed to deny permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    const handleDecisionApprove = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        setLoadingButton('allow');
        try {
            await dispatchPermissionAction(() => (
                sessionAllow(sessionId, permission.id, undefined, undefined, 'approved')
            ));
        } catch (error) {
            console.error('Failed to approve permission:', error);
        } finally {
            setLoadingButton(null);
        }
    };
    
    const handleDecisionApproveForSession = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        setLoadingForSession(true);
        try {
            await dispatchPermissionAction(() => (
                sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session')
            ));
        } catch (error) {
            console.error('Failed to approve for session:', error);
        } finally {
            setLoadingForSession(false);
        }
    };

    const handleDecisionApproveExecPolicy = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy || !canApproveExecPolicy) return;

        setLoadingExecPolicy(true);
        try {
            await dispatchPermissionAction(() => (
                sessionAllow(
                    sessionId,
                    permission.id,
                    undefined,
                    undefined,
                    'approved_execpolicy_amendment',
                    { command: execPolicyCommand }
                )
            ));
        } catch (error) {
            console.error('Failed to approve with execpolicy amendment:', error);
        } finally {
            setLoadingExecPolicy(false);
        }
    };
    
    const handleDecisionDenyWithoutSessionAbort = async () => {
        if (permission.status !== 'pending' || loadingButton !== null || loadingForSession || loadingExecPolicy) return;
        
        setLoadingButton('abort');
        try {
            await dispatchPermissionAction(() => (
                sessionDeny(sessionId, permission.id, undefined, undefined, 'denied')
            ));
        } catch (error) {
            console.error('Failed to abort permission:', error);
        } finally {
            setLoadingButton(null);
        }
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

    const isBroadShellGrantEligible = (command: string): boolean => {
        const trimmed = command.trim();
        if (!trimmed) return false;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) || /^unset(?:\s|$)/.test(trimmed)) return false;
        // Broad command-name grants intentionally cover one simple command only.
        // Exact one-off approval remains available for complex shell syntax.
        return !/[;&|<>`\r\n]/.test(trimmed) && !trimmed.includes('$(');
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
            if (!isBroadShellGrantEligible(command)) return false;
            const effectiveCommand = command.trim();
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
        if (!isBroadShellGrantEligible(commandForShell)) return false;
        const effectiveCommand = commandForShell.trim();
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
        if (!isBroadShellGrantEligible(commandForShell)) return false;
        const effective = commandForShell.trim();
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

    // Render Codex-style decision buttons if the agent uses the Codex decision protocol.
    if (copy.protocol === 'codexDecision') {
        return (
            <View style={[styles.container, embedded ? styles.containerEmbedded : styles.containerStandalone]}>
                <View style={styles.buttonContainer}>
                    {/* Decision protocol: Yes button */}
                    <TouchableOpacity
                        testID="permission-footer.allow"
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonAllow,
                            isCodexApproved && styles.buttonSelected,
                            (isCodexAborted || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleDecisionApprove}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
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
                            style={[
                                styles.button,
                                alignedButtonStyle,
                                isPending && styles.buttonForSession,
                                isCodexApprovedExecPolicy && styles.buttonSelected,
                                (isCodexAborted || isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                            ]}
                            onPress={handleDecisionApproveExecPolicy}
                            disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={handleDecisionApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonDeny,
                            isDeniedViaNo && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive,
                        ]}
                        onPress={handleDeny}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonDeny,
                            isCodexAborted && styles.buttonSelected,
                            (isCodexApproved || isCodexApprovedForSession || isCodexApprovedExecPolicy) && styles.buttonInactive
                        ]}
                        onPress={shouldHandleStopWithoutSessionAbort ? handleDecisionDenyWithoutSessionAbort : handleStop}
                        disabled={!isPending || loadingButton !== null || loadingForSession || loadingExecPolicy}
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
            </View>
        );
    }

    // Render rule-update buttons for the non-decision protocol.
    const showAllowForSessionSubcommand = isShellTool && typeof commandForShell === 'string' && (() => {
        if (!isBroadShellGrantEligible(commandForShell)) return false;
        const parts = commandForShell.trim().split(/\s+/).filter(Boolean);
        const cmd = parts[0];
        const sub = parts[1];
        return Boolean(cmd) && Boolean(sub) && !String(sub).startsWith('-') && ['git', 'npm', 'yarn', 'pnpm', 'cargo', 'docker', 'kubectl', 'gh', 'brew'].includes(String(cmd));
    })();
    const showAllowForSessionCommandName =
        isShellTool
        && typeof commandForShell === 'string'
        && isBroadShellGrantEligible(commandForShell)
        && Boolean(commandForShell.trim().split(/\s+/).filter(Boolean)[0]);
    return (
        <View style={[styles.container, embedded ? styles.containerEmbedded : styles.containerStandalone]}>
            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    testID="permission-footer.allow"
                    style={[
                        styles.button,
                        alignedButtonStyle,
                        isPending && styles.buttonAllow,
                        isApprovedViaAllow && styles.buttonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            ((isShellTool ? isApprovedForSessionToolWide : isApprovedForSession) && styles.buttonSelected),
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSession}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            (isApprovedForSessionSubcommand && !isApprovedForSessionCommandName) && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSessionToolWide || isApprovedForSessionExact) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionSubcommand}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
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
                                        const parts = String(commandForShell).trim().split(/\s+/).filter(Boolean);
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
                        style={[
                            styles.button,
                            alignedButtonStyle,
                            isPending && styles.buttonForSession,
                            isApprovedForSessionCommandName && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSessionToolWide || isApprovedForSessionExact || isApprovedForSessionSubcommand) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSessionCommandName}
                        disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession || loadingForSessionPrefix || loadingForSessionCommandName}
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
                                    {t('claude.permissions.yesForCommandName')}{typeof commandForShell === 'string' ? ` (${commandForShell.trim().split(/\s+/).filter(Boolean)[0] ?? ''})` : ''}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    testID="permission-footer.deny"
                    style={[
                        styles.button,
                        alignedButtonStyle,
                        isPending && styles.buttonDeny,
                        isDeniedViaNo && styles.buttonSelected,
                        (isApproved || isStopped) && styles.buttonInactive,
                    ]}
                    onPress={handleDeny}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
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
                    style={[
                        styles.button,
                        alignedButtonStyle,
                        isPending && styles.buttonDeny,
                        isStopped && styles.buttonSelected,
                        (isApproved || isDeniedViaNo) && styles.buttonInactive,
                    ]}
                    onPress={handleStop}
                    disabled={!isPending || loadingButton !== null || loadingAllEdits || loadingForSession}
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
        </View>
    );
};
