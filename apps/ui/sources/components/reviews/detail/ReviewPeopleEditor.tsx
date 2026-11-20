import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { buildDirectorySelectionSection, SharePrincipalVisual, type SharePrincipalPresentation } from '@happier-dev/plugin-ui/components';
import type { ReviewRequestedReviewerInputV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';

import { useSessionAccessDirectory } from '@/components/sessions/access/useSessionAccessDirectory';
import type { SessionAccessDirectoryTeamContext } from '@/components/sessions/access/useSessionAccessDirectory';
import type { SessionAccessGrantOperationModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import { presentSharePrincipal, sharePrincipalKey } from '@/components/sharing/sharePrincipalPresentation';
import { SHARE_SHEET_HOST } from '@/components/sharing/shareSheetHost';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { SelectionList, createDefaultDynamicSectionCache, type SelectionListOption, type SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import type { ReviewSubmitResult } from './ReviewSubmitPanel';

const NO_TEAMS: readonly SessionAccessDirectoryTeamContext[] = Object.freeze([]);
const NO_OPERATIONS: Readonly<Record<string, SessionAccessGrantOperationModel>> = Object.freeze({});

/** Requested people are a round draft; saving never grants access to the Review. */
export function ReviewPeopleEditor(props: Readonly<{
    scope: ServerAccountScope;
    roundOrdinal: number;
    initialReviewers: readonly ReviewRequestedReviewerInputV1[];
    names: ReadonlyMap<string, string> | null;
    onSubmit: (reviewers: readonly ReviewRequestedReviewerInputV1[]) => Promise<ReviewSubmitResult>;
    onCancel: () => void;
}>): React.ReactElement {
    const [draft, setDraft] = React.useState(() => [...props.initialReviewers]);
    const [query, setQuery] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [failure, setFailure] = React.useState<string | null>(null);
    const [chosen, setChosen] = React.useState<ReadonlyMap<string, SharePrincipalPresentation>>(() => new Map());
    const [dynamicSectionCache] = React.useState(createDefaultDynamicSectionCache);
    const directory = useSessionAccessDirectory({ scope: props.scope, availability: 'available', contextTeams: NO_TEAMS,
        operations: NO_OPERATIONS, revision: 0, enabled: true });
    const sections = React.useMemo((): readonly SelectionListSectionDescriptor[] => {
        const selected = new Set(draft.map(row => sharePrincipalKey(row.principal)));
        const current: SelectionListOption[] = draft.map(row => {
            const key = sharePrincipalKey(row.principal);
            const principal = chosen.get(key) ?? presentSharePrincipal({ ref: row.principal, name: props.names?.get(key), viewerAccountId: props.scope.accountId });
            return { id: `selected:${key}`, label: principal.displayName, testID: `review-people:selected:${key}`,
                icon: () => <SharePrincipalVisual host={SHARE_SHEET_HOST} principal={principal} testID={`review-people:visual:${key}`} />,
                rightAccessoryOutsidePressable: true, rightAccessory: () => <View style={styles.actions}>
                    <Pressable testID={`review-people:required:${key}`} accessibilityRole="checkbox"
                        accessibilityLabel={`${t('reviewWalkthrough.detail.required')}: ${principal.displayName}`}
                        accessibilityState={{ checked: row.required, disabled: busy }} disabled={busy}
                        aria-checked={row.required} aria-disabled={busy || undefined}
                        onPress={() => setDraft(current => current.map(item => sharePrincipalKey(item.principal) === key ? { ...item, required: !item.required } : item))}
                        style={styles.actions}>
                        <SelectionCheckGlyph state={row.required ? 'checked' : 'unchecked'} size="compact" />
                        <Text variant="meta">{t(row.required ? 'reviewWalkthrough.detail.required' : 'reviewWalkthrough.detail.optional')}</Text>
                    </Pressable>
                    <TextLinkButton testID={`review-people:remove:${key}`} label={t('common.remove')} disabled={busy}
                        onPress={() => setDraft(current => current.filter(item => sharePrincipalKey(item.principal) !== key))} />
                </View> };
        });
        const result: SelectionListSectionDescriptor[] = [{ kind: 'static', id: 'requested', title: t('reviewWalkthrough.detail.people'), options: current }];
        for (const source of directory.sections) {
            result.push(buildDirectorySelectionSection({ loadingLabel: t('common.loading'), source, id: `people:${source.kind}`,
                title: source.title, resolverKey: JSON.stringify([source.resolverKey, source.candidates.map(row => row.principal.key), [...selected], busy]),
                showSkeletonsOnFirstLoad: true, options: rows => rows.filter(row => !selected.has(row.principal.key)).map(row => ({
                    id: row.principal.key, label: row.principal.displayName, subtitle: row.principal.secondaryLabel,
                    testID: `review-people:candidate:${row.principal.key}`, disabled: busy,
                    icon: () => <SharePrincipalVisual host={SHARE_SHEET_HOST} principal={row.principal} testID={`review-people:visual:${row.principal.key}`} />,
                    onSelect: () => {
                        setChosen(current => new Map(current).set(row.principal.key, row.principal));
                        setDraft(current => current.some(item => sharePrincipalKey(item.principal) === row.principal.key)
                            ? current : [...current, { principal: row.principal.ref, required: true }]);
                    },
                })) }));
            if (source.status === 'error' || source.hasMore) result.push({ kind: 'static', id: `people-page:${source.kind}`, options: [{
                id: `more:${source.kind}`, label: source.status === 'error' ? t('common.retry')
                    : t(source.kind === 'account' ? 'shareSheet.browsePeople' : source.kind === 'team' ? 'shareSheet.browseTeams' : 'shareSheet.browseGroups'),
                loading: source.loadingMore, disabled: busy || source.loadingMore,
                onSelect: () => source.status === 'error' ? directory.retry(source.kind) : directory.loadMore(source.kind),
            }] });
        }
        return result;
    }, [busy, chosen, directory, draft, props.names, props.scope.accountId]);
    const submit = async () => {
        setBusy(true);
        setFailure(null);
        try {
            const result = await props.onSubmit(draft);
            if (!result.ok) setFailure(result.message);
        } finally { setBusy(false); }
    };
    return <ItemGroup testID="review-people" title={t('reviewWalkthrough.detail.people')}
        titleAccessory={<Text variant="meta">{t('reviewWalkthrough.detail.round', { round: props.roundOrdinal })}</Text>}>
        <SelectionList testID="review-people:directory" currentUiContextCommandScope="review.people" surface="none"
            rootStep={{ id: 'review-people', inputPlaceholder: t('shareSheet.addPlaceholder'), disableInputFilter: true, sections }}
            inputValue={query} onChangeInputValue={setQuery} dynamicSectionCache={dynamicSectionCache}
            onSelect={() => {}} onRequestClose={props.onCancel} />
        {failure ? <SurfaceStateCard kind="error" size="line" title={failure} /> : null}
        <View style={styles.footer}>
            <TextLinkButton testID="review-people:cancel" label={t('common.cancel')} disabled={busy} onPress={props.onCancel} />
            <RoundButton testID="review-people:save" title={t('common.save')} size="small" loading={busy} disabled={busy}
                onPress={() => { void submit(); }} />
        </View>
    </ItemGroup>;
}

const styles = StyleSheet.create(theme => ({
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: theme.space.s16, padding: theme.space.s16 },
}));
