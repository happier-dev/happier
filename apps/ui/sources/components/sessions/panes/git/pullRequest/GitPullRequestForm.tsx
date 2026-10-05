import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ScmBranchListEntry } from '@happier-dev/protocol';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Switch } from '@/components/ui/forms/Switch';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ToolbarSelect } from '@/components/ui/forms/ToolbarSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionScmDraft } from '@/hooks/session/sourceControl/useSessionScmDraft';
import { resolveSourceControlPullRequestViewModel } from '@/components/workspaces/scm/update/resolveSourceControlPullRequestViewModel';
import { validateScmFollowupOpenUrl } from '@/components/workspaces/scm/update/validateScmFollowupOpenUrl';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { sessionScmBranchList, sessionScmPullRequestOpenCompose } from '@/sync/ops/sessionScm';
import type { SessionScmPullRequestDraftV1 } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { t } from '@/text';

import { createSessionGitPullRequest } from './createSessionGitPullRequest';
import { GitPullRequestProviderMark, resolveGitPullRequestProvider } from './GitPullRequestProviderMark';
import {
    resolveGitPullRequestFormAfterCreate,
    type GitPullRequestFormAfterCreate,
    type GitPullRequestFormPlacement,
} from './gitPullRequestFormState';

export type GitPullRequestCreated = Readonly<{
    number: number | null;
    url: string;
    title: string;
    base: string;
}>;

const EMPTY_DRAFT: SessionScmPullRequestDraftV1 = { title: '', body: '', draft: false, base: null };

/**
 * The new pull request form (Git lab PR / PRD): the same component in the Git sidebar and in its Details
 * destination; its text is the session draft, so moving it between them, closing it or reopening it on another
 * device keeps what was written. It shows only what the provider contract can do: Draft only when the daemon
 * creates drafts, and a hand-off to the provider page when in-app creation is not available.
 */
export const GitPullRequestForm = React.memo(function GitPullRequestForm(props: Readonly<{
    sessionId: string;
    serverId?: string;
    snapshot: ScmWorkingSnapshot;
    machineReachable: boolean;
    placement: GitPullRequestFormPlacement;
    /** Sidebar: move into the Details destination. */
    onExpand?: () => void;
    /** Details: move back into the Git sidebar. */
    onMoveBack?: () => void;
    onClose: () => void;
    onCreated: (created: GitPullRequestCreated) => void;
}>) {
    const { theme } = useUnistyles();
    const scmDraft = useSessionScmDraft({ sessionId: props.sessionId, serverId: props.serverId });
    const draft = scmDraft.draft.pullRequest ?? EMPTY_DRAFT;
    const model = resolveSourceControlPullRequestViewModel({ snapshot: props.snapshot });
    const provider = resolveGitPullRequestProvider(props.snapshot);
    const head = model.headBranch;
    const base = draft.base ?? model.baseBranch;
    const inAppCreate = model.primaryAction?.kind === 'open-or-reuse';
    const draftSupported = inAppCreate && props.snapshot.capabilities?.writePullRequestDraftCreate === true;
    const [busy, setBusy] = React.useState(false);
    const [result, setResult] = React.useState<GitPullRequestFormAfterCreate | null>(null);

    const latestDraftRef = React.useRef(draft);
    latestDraftRef.current = draft;
    const update = React.useCallback((patch: Partial<SessionScmPullRequestDraftV1>) => {
        setResult(null);
        scmDraft.setPullRequest({ ...latestDraftRef.current, ...patch });
    }, [scmDraft]);

    const branches = useLocalBranchNames(props.sessionId, props.serverId);
    const baseItems = React.useMemo(() => {
        const names = new Set<string>();
        if (base) names.add(base);
        if (model.baseBranch) names.add(model.baseBranch);
        for (const name of branches) if (name !== head) names.add(name);
        return Array.from(names, (name) => ({ id: name, title: name }));
    }, [base, branches, head, model.baseBranch]);

    const create = React.useCallback(() => {
        if (busy || !head || !base) return;
        const current = latestDraftRef.current;
        setBusy(true);
        setResult(null);
        void (async () => {
            try {
                if (!inAppCreate) {
                    const response = await sessionScmPullRequestOpenCompose(props.sessionId, { base, head }, props.serverId);
                    if (response.success && response.nextAction.kind === 'openUrl') {
                        const safe = validateScmFollowupOpenUrl(response.nextAction);
                        if (safe.ok) {
                            await openExternalUrl(safe.url);
                            setResult(resolveGitPullRequestFormAfterCreate({ kind: 'provider-page', url: safe.url }));
                            return;
                        }
                    }
                    setResult(resolveGitPullRequestFormAfterCreate({
                        kind: 'failed', errorCode: 'COMMAND_FAILED',
                        message: !response.success ? response.error : t('sessionGitPullRequest.failure.other'),
                    }));
                    return;
                }
                const outcome = await createSessionGitPullRequest({
                    state: storage.getState(),
                    sessionId: props.sessionId,
                    ...(props.serverId === undefined ? {} : { serverId: props.serverId }),
                    machineReachable: props.machineReachable,
                    draftSupported,
                    request: { base, head, title: current.title, body: current.body, draft: current.draft },
                });
                const next = resolveGitPullRequestFormAfterCreate(outcome);
                if (next.openedProviderPage) await openExternalUrl(next.openedProviderPage);
                if (next.created) {
                    props.onCreated({ ...next.created, title: current.title.trim(), base });
                }
                if (next.clearDraft) scmDraft.setPullRequest(null);
                setResult(next);
            } finally {
                setBusy(false);
            }
        })();
    }, [base, busy, draftSupported, head, inAppCreate, props, scmDraft]);

    const failureText = result?.failure ? describeFailure(result.failure, provider.displayName) : null;
    const canCreate = Boolean(head && base) && !busy && (inAppCreate ? true : model.primaryAction?.kind === 'open-compose');
    const createLabel = busy
        ? t('sessionGitPullRequest.form.creating')
        : inAppCreate
            ? t('sessionGitPullRequest.form.create')
            : t('sessionGitPullRequest.form.continueOn', { provider: provider.displayName });

    return (
        <View testID={`git-pull-request-form:${props.placement}`} style={props.placement === 'sidebar' ? styles.card : styles.page}>
            <View style={styles.headerRow}>
                <GitPullRequestProviderMark kind={provider.kind} size={18} />
                <Text numberOfLines={1} style={styles.title}>{t('sessionGitPullRequest.form.title')}</Text>
                {props.onExpand ? (
                    <IconButton
                        testID="git-pull-request-form-expand"
                        variant="plain"
                        size={28}
                        accessibilityLabel={t('sessionGitPullRequest.form.expand')}
                        tooltip={t('sessionGitPullRequest.form.expand')}
                        icon={<Icon name="arrows-out" size={15} color={theme.colors.text.secondary} />}
                        onPress={props.onExpand}
                    />
                ) : null}
                {props.onMoveBack ? (
                    <ToolbarButton
                        testID="git-pull-request-form-move-back"
                        label={t('sessionGitPullRequest.form.moveBack')}
                        size="sm"
                        onPress={props.onMoveBack}
                    />
                ) : null}
                <IconButton
                    testID="git-pull-request-form-close"
                    variant="plain"
                    size={28}
                    accessibilityLabel={t('sessionGitPullRequest.form.close')}
                    tooltip={t('sessionGitPullRequest.form.close')}
                    icon={<Icon name="x" size={15} color={theme.colors.text.secondary} />}
                    onPress={props.onClose}
                />
            </View>
            <View style={styles.branchRow}>
                <View style={styles.branchChip}>
                    <Icon name="git-branch" size={12} color={theme.colors.text.secondary} />
                    <Text numberOfLines={1} style={styles.branchText}>{head ?? ''}</Text>
                </View>
                <Icon name="arrow-right" size={13} color={theme.colors.text.tertiary} />
                <ToolbarSelect
                    testID="git-pull-request-form-base"
                    label={t('sessionGitPullRequest.form.base')}
                    items={baseItems}
                    selectedId={base}
                    onSelect={(id) => update({ base: id === model.baseBranch ? null : id })}
                    disabled={busy}
                />
            </View>
            <FieldTextInput
                testID="git-pull-request-form-title"
                value={draft.title}
                onChangeText={(title) => update({ title })}
                placeholder={t('sessionGitPullRequest.form.titlePlaceholder')}
                accessibilityLabel={t('sessionGitPullRequest.form.titlePlaceholder')}
                editable={!busy}
            />
            <FieldTextInput
                testID="git-pull-request-form-body"
                value={draft.body}
                onChangeText={(body) => update({ body })}
                placeholder={t('sessionGitPullRequest.form.bodyPlaceholder')}
                accessibilityLabel={t('sessionGitPullRequest.form.bodyPlaceholder')}
                editable={!busy}
                multiline
                minLines={props.placement === 'details' ? 10 : 4}
            />
            {failureText ? (
                <View testID="git-pull-request-form-failure" accessibilityRole="alert" style={styles.failure}>
                    <Icon name="warning-circle" size={14} color={theme.colors.state.danger.foreground} />
                    <View style={styles.failureText}>
                        <Text style={styles.failureTitle}>{failureText}</Text>
                        {result?.failure?.message && !result.failure.blocked ? (
                            <Text numberOfLines={3} style={styles.failureDetail}>{result.failure.message}</Text>
                        ) : null}
                    </View>
                </View>
            ) : null}
            {result?.openedProviderPage ? (
                <Text testID="git-pull-request-form-provider-page" style={styles.note}>
                    {t('sessionGitPullRequest.form.openedProviderPage', { provider: provider.displayName })}
                </Text>
            ) : null}
            <View style={styles.footer}>
                {draftSupported ? (
                    <View style={styles.draftToggle}>
                        <Switch
                            testID="git-pull-request-form-draft"
                            value={draft.draft}
                            onValueChange={(value) => update({ draft: value })}
                            disabled={busy}
                            accessibilityLabel={t('sessionGitPullRequest.form.draft')}
                        />
                        <Text style={styles.draftLabel}>{t('sessionGitPullRequest.form.draft')}</Text>
                    </View>
                ) : <View />}
                <ToolbarButton
                    testID="git-pull-request-form-create"
                    label={createLabel}
                    tone="primary"
                    busy={busy}
                    disabled={!canCreate}
                    onPress={create}
                />
            </View>
        </View>
    );
});

function describeFailure(failure: NonNullable<GitPullRequestFormAfterCreate['failure']>, provider: string): string {
    if (failure.blocked) return t('sessionGitPullRequest.failure.blocked');
    switch (failure.errorCode) {
        case 'REMOTE_AUTH_REQUIRED': return t('sessionGitPullRequest.failure.authFailed', { provider });
        case 'REMOTE_NETWORK_FAILED': return t('sessionGitPullRequest.failure.network', { provider });
        default: return t('sessionGitPullRequest.failure.other');
    }
}

/** Local branch names for the base picker, read once while the form is open (opening it is the intent). */
function useLocalBranchNames(sessionId: string, serverId: string | undefined): readonly string[] {
    const [names, setNames] = React.useState<readonly string[]>([]);
    React.useEffect(() => {
        let cancelled = false;
        void sessionScmBranchList(sessionId, {}, serverId).then((response) => {
            if (cancelled || !response.success) return;
            setNames((response.branches ?? [])
                .filter((entry: ScmBranchListEntry) => entry.type === 'local')
                .map((entry: ScmBranchListEntry) => entry.name));
        }).catch(() => {
            // The picker keeps the provider's default base; the form still works.
        });
        return () => {
            cancelled = true;
        };
    }, [serverId, sessionId]);
    return names;
}

const styles = StyleSheet.create((theme) => ({
    card: {
        marginHorizontal: 12,
        marginTop: 8,
        marginBottom: 4,
        padding: 12,
        gap: 10,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    page: {
        padding: 16,
        gap: 12,
    },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flex: 1, minWidth: 0, fontSize: 15, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    branchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    branchChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
        maxWidth: 180,
    },
    branchText: { fontSize: 12, color: theme.colors.text.primary, ...Typography.mono() },
    failure: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    failureText: { flex: 1, minWidth: 0, gap: 2 },
    failureTitle: { fontSize: 13, color: theme.colors.text.primary, ...Typography.default('semiBold') },
    failureDetail: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() },
    note: { fontSize: 12, color: theme.colors.text.secondary, ...Typography.default() },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
    draftToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    draftLabel: { fontSize: 13, color: theme.colors.text.secondary, ...Typography.default() },
}));
