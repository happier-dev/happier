import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import { ShareSheet } from '../ShareSheet';
import { presentSharePrincipal, sharePrincipalKey } from '../sharePrincipalPresentation';
import { useShareViewerProfile } from '../useShareViewerProfile';
import type { SharePrincipalPresentation, ShareSheetActions, ShareSheetAdapter } from '../shareSheetTypes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createDocumentShareAdapter } from './documentShareAdapter';
import { DocumentSignedInLinkSection } from './DocumentSignedInLinkSection';
import type { DocumentShareSheetProps } from './DocumentShareSheet';

export type DocumentShareSelection = Readonly<{ recipients: readonly PrincipalRefV1[]; signedInLink: boolean }>;
export type ReviewedDocumentShareSelection = Readonly<{
    onSubmit(selection: DocumentShareSelection): Promise<void | Readonly<{ shareUrl?: string }>>;
}>;

const EMPTY_TEAMS: readonly [] = [];
const EMPTY_OPERATIONS = {};
const noop = () => {};
const styles = StyleSheet.create(theme => ({
    root: { flex: 1, minHeight: 0 },
    footer: { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s8 },
}));

/** The existing sheet stages audience intent; the host's reviewed release owns every write. */
export function ReviewedDocumentShareSheet(props: DocumentShareSheetProps & Readonly<{
    scope: ServerAccountScope; reviewedSelection: ReviewedDocumentShareSelection;
}>) {
    const [selected, setSelected] = React.useState<readonly SharePrincipalPresentation[]>([]);
    const [query, setQuery] = React.useState('');
    const [signedInLink, setSignedInLink] = React.useState(false);
    const [pending, setPending] = React.useState(false);
    const [shared, setShared] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const [shareUrl, setShareUrl] = React.useState<string | null>(null);
    const editable = !pending && !shared;
    const directory = useSessionAccessDirectory({ scope: props.scope, availability: 'available', contextTeams: EMPTY_TEAMS,
        operations: EMPTY_OPERATIONS, revision: 0, enabled: editable });
    const seen = React.useRef(new Map<string, SharePrincipalPresentation>());
    const sections = React.useMemo(() => directory.sections.map(section => ({ ...section,
        ...(section.resolveCandidates ? { resolveCandidates: async (search: string, signal: AbortSignal) => {
            const candidates = await section.resolveCandidates!(search, signal);
            for (const row of candidates) seen.current.set(row.principal.key, row.principal);
            return candidates;
        } } : {}),
    })), [directory.sections]);
    const remove = (principal: PrincipalRefV1) => {
        if (editable) setSelected(rows => rows.filter(row => row.key !== sharePrincipalKey(principal)));
    };
    const actions: ShareSheetActions = {
        setQuery, retryDirectory: directory.retry, loadMore: directory.loadMore,
        addPrincipal: principal => {
            if (!editable) return;
            const key = sharePrincipalKey(principal);
            const known = seen.current.get(key) ?? directory.sections.flatMap(section => section.candidates)
                .find(row => row.principal.key === key)?.principal;
            if (known) setSelected(rows => rows.some(row => row.key === key) ? rows : [...rows, known]);
        },
        retryMutation: noop, setAccessLevel: noop, requestRemove: remove, confirmRemove: remove, cancelRemove: noop,
        explain: reason => { void Modal.alert(t('common.error'), reason.message); },
    };
    const profile = useShareViewerProfile(props.scope);
    const adapter: ShareSheetAdapter = {
        ...createDocumentShareAdapter({ artifactId: props.artifactId, kind: props.kind, grants: [], loading: false,
            readOnly: false, retryContent: noop }),
        levels: { view: { label: t('botTemplates.canCopy') } },
        showsLevelLock: () => true,
        publicLink: {
            label: t('botTemplates.signedInLink'), stateLabel: t(signedInLink ? 'common.on' : 'common.off'),
            renderContent: context => <DocumentSignedInLinkSection value={signedInLink} onChange={setSignedInLink}
                disabled={!editable} shareUrl={shareUrl} scope={props.scope} idPrefix={context.idPrefix} />,
        },
    };
    const submit = async () => {
        if (!editable || (!selected.length && !signedInLink)) return;
        setPending(true); setFailed(false);
        try {
            const result = await props.reviewedSelection.onSubmit({ recipients: selected.map(row => row.ref), signedInLink });
            setShareUrl(result?.shareUrl ?? null);
            setShared(true);
        } catch { setFailed(true); }
        finally { setPending(false); }
    };
    return <View style={styles.root}>
        <ShareSheet presentation={props.presentation ?? 'full'} onRequestClose={props.onRequestClose}
            testID={props.testID ?? 'document-share-editor'} adapter={adapter} actions={actions}
            model={{ revision: selected.length, editable, stale: false,
                owner: { principal: presentSharePrincipal({ ref: { kind: 'account', accountId: props.scope.accountId },
                    profile, viewerAccountId: props.scope.accountId }) },
                grants: selected.map(principal => ({ grant: principal.ref, principal,
                    level: { kind: 'locked', value: 'view', reason: { code: 'can_copy', message: t('botTemplates.canCopy') } },
                    removal: { kind: 'allowed' }, operation: { kind: 'idle' } })),
                directory: { query, sections } }} />
        <KeyboardStickyFooter style={styles.footer}>
            {failed ? <AttentionBanner testID="document-share-error" tone="danger" title={t('botTemplates.unavailable')} /> : null}
            <RoundButton testID="document-share-submit" title={t(shared ? 'botTemplates.shared' : 'common.share')}
                loading={pending} disabled={!editable || (!selected.length && !signedInLink)} onPress={() => { void submit(); }} />
        </KeyboardStickyFooter>
    </View>;
}
