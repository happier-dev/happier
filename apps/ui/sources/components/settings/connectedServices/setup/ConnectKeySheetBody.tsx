import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { sharedSecretProvenanceSegments } from '@/components/secrets/savedSecretRowCopy';
import type { SavedSecretCatalogProjection } from '@/components/secrets/useSavedSecretCatalog';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { COLLECTION_LIST_SEARCH_THRESHOLD } from '@/components/ui/lists/collection/CollectionList';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';

type KeyMode = 'new' | 'saved';

/**
 * The Connect sheet's body for a bare key (an API key, a token, a secret): New key | Saved key.
 * New key is the one Saved Secret create form; Saved key lists the keys the presenter ranked for this
 * request (own key = one press, it is the grant; someone else's waits for their OK once). The presenter
 * decides the order, which tab opens and which key is preselected; this body draws them, says why a row
 * leads, and reports the choice. The mode switch and search stay put while the list scrolls under them.
 */
export function ConnectKeySheetBody(
  props: Readonly<{
    catalog: SavedSecretCatalogProjection;
    /** The presenter's ranked, filtered keys: current link, then keys used for the same thing, then the rest. */
    linkableEntries: readonly SavedSecretCatalogEntryV1[];
    initialMode: KeyMode;
    preselected: string | null;
    loading: boolean;
    scope: AccountSettingsScope | null;
    /** The key the caller has linked now, and keys linked to the same thing elsewhere: the row says so. */
    currentRef?: string | null;
    sameTargetRefs?: readonly string[];
    /** The name a new key starts with ("DeepSeek key"); the person can change it. */
    suggestedName?: string;
    /** The primary's words for a requested key ("Save key"); a bare secret keeps "Save secret". */
    submitLabel?: string;
    onResult: (
      result: Readonly<{ kind: 'connected' | 'selected'; secretRef: string }>,
    ) => void;
    onCancel: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const linkable = props.linkableEntries;
  const hasSaved = linkable.length > 0;
  const [chosenMode, setChosenMode] = React.useState<KeyMode | null>(null);
  const mode: KeyMode = !hasSaved ? 'new' : (chosenMode ?? props.initialMode);
  const [chosenRef, setChosenRef] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const selectedRef =
    chosenRef ??
    (linkable.some((entry) => entry.ref === props.preselected)
      ? props.preselected
      : null);
  const selected = linkable.find((entry) => entry.ref === selectedRef) ?? null;

  // The kind only tells rows apart when they differ; a list of API keys does not say "API key" on every row.
  const kindsDiffer = React.useMemo(
    () => new Set(linkable.map((entry) => entry.kind ?? null)).size > 1,
    [linkable],
  );
  const sameTarget = React.useMemo(
    () => new Set(props.sameTargetRefs ?? []),
    [props.sameTargetRefs],
  );
  const searchable =
    query.length > 0 || linkable.length >= COLLECTION_LIST_SEARCH_THRESHOLD;
  const needle = searchable ? query.trim().toLocaleLowerCase() : '';
  const shown = React.useMemo(
    () =>
      needle
        ? linkable.filter((entry) =>
            [entry.name, entry.owner ? formatAccountDisplayName(entry.owner) : null]
              .some((text) => text?.toLocaleLowerCase().includes(needle)),
          )
        : linkable,
    [linkable, needle],
  );

  const scopeKey = props.scope
    ? `${props.scope.serverId}:${props.scope.accountId}`
    : null;
  const approval = useActionApprovalContinuation({
    scopeKey: scopeKey ?? 'unbound:connect-key-sheet',
    serverId: props.scope?.serverId ?? '',
    onExecuted: () => {
      void props.catalog.reload().catch(() => undefined);
    },
  });
  const approvalId = approval.approvalId;
  const openApproval =
    approvalId && props.scope
      ? () =>
          router.pushRetainingCurrent(
            `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(props.scope!.serverId)}`,
          )
      : undefined;

  const tabs = React.useMemo(
    () => [
      { id: 'new' as const, label: t('connectedServicesSetup.keyNew') },
      { id: 'saved' as const, label: t('connectedServicesSetup.keySaved') },
    ],
    [],
  );

  if (props.loading) {
    // The opening decision waits for the catalog; the line holds the body's place meanwhile.
    return (
      <SurfaceStateCard
        testID="connect-key-sheet:loading"
        size="line"
        kind="loading"
        title={t('common.loading')}
      />
    );
  }

  const reasonFor = (entry: SavedSecretCatalogEntryV1): string | null => {
    if (props.currentRef && entry.ref === props.currentRef)
      return t('connectedServicesSetup.keyInUseHere');
    if (sameTarget.has(entry.ref))
      return t('connectedServicesSetup.keyUsedElsewhereForThis');
    return null;
  };

  return (
    <View style={styles.body} testID="connect-key-sheet">
      {hasSaved ? (
        <SegmentedTabBar
          role="radiogroup"
          labelSize="field"
          segmentSizing="equal"
          accessibilityLabel={t('connectedServicesSetup.keyHowToAdd')}
          tabs={tabs}
          activeTabId={mode}
          onSelectTab={setChosenMode}
          testIDPrefix="connect-key-sheet:mode"
        />
      ) : null}
      {mode === 'new' ? (
        <ScrollView
          style={styles.scroll}
          keyboardShouldPersistTaps="handled"
          testID="connect-key-sheet:new"
        >
          <SavedSecretCreateEditor
            scope={props.scope}
            presentation="sheet"
            initialName={props.suggestedName}
            submitLabel={props.submitLabel}
            onCreatePersonal={props.catalog.personalMutations.create}
            sharedAvailable={props.catalog.sharedEnabled}
            approvalPending={approval.approvalPending}
            approvalId={approvalId}
            requestApproval={approval.requestApproval}
            onOpenApproval={openApproval}
            onCancel={props.onCancel}
            onCreated={(ref) =>
              props.onResult({ kind: 'connected', secretRef: ref })
            }
          />
        </ScrollView>
      ) : (
        <>
          {searchable ? (
            <CompactSearchField
              value={query}
              onChangeText={setQuery}
              placeholder={t('connectedServicesSetup.keySearch')}
              testID="connect-key-sheet:search"
            />
          ) : null}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.keys}
            keyboardShouldPersistTaps="handled"
            accessibilityRole="radiogroup"
            testID="connect-key-sheet:saved"
          >
            {shown.length === 0 ? (
              <SurfaceStateCard
                testID="connect-key-sheet:no-matches"
                kind="empty"
                size="line"
                title={t('common.noMatches')}
              />
            ) : null}
            {shown.map((entry) => {
              const isSelected = entry.ref === selectedRef;
              const ownerName =
                entry.relationship === 'recipient' && entry.owner
                  ? formatAccountDisplayName(entry.owner)
                  : null;
              const kind =
                kindsDiffer && entry.kind
                  ? t(`secrets.catalog.kinds.${entry.kind}`)
                  : null;
              const facts = [
                reasonFor(entry),
                kind,
                ...sharedSecretProvenanceSegments(entry),
              ].filter((fact): fact is string => Boolean(fact));
              return (
                <SelectableRow
                  key={entry.ref}
                  testID={`connect-key-sheet:saved:${entry.ref}`}
                  presentation="menu"
                  accessibilityRole="radio"
                  accessibilityChecked={isSelected}
                  left={
                    <Icon
                      name="key"
                      size={ICON_SIZE.sm}
                      color={theme.colors.text.secondary}
                    />
                  }
                  title={entry.name}
                  subtitle={facts.length > 0 ? facts.join(' · ') : undefined}
                  right={
                    ownerName || isSelected ? (
                      <View style={styles.trailing}>
                        {ownerName ? (
                          <Text style={styles.approves} numberOfLines={1}>
                            {t('connectedServicesSetup.keyOwnerApprovesFirst', {
                              owner: ownerName,
                            })}
                          </Text>
                        ) : null}
                        {/* The chosen key carries the menus' check; a slot keeps every row's text edge. */}
                        <View style={styles.mark}>
                          {isSelected ? (
                            <Icon
                              testID={`connect-key-sheet:selected:${entry.ref}`}
                              name="check"
                              size={ICON_SIZE.sm}
                              color={theme.colors.text.primary}
                            />
                          ) : null}
                        </View>
                      </View>
                    ) : (
                      <View style={styles.mark} />
                    )
                  }
                  onPress={() => setChosenRef(entry.ref)}
                />
              );
            })}
          </ScrollView>
          <RoundButtonSizeScope size="normal" presentation="uniform">
            <View style={styles.actions}>
              <RoundButton
                testID="connect-key-sheet:cancel"
                display="secondary"
                title={t('common.cancel')}
                onPress={props.onCancel}
              />
              <RoundButton
                testID="connect-key-sheet:use"
                title={
                  selected
                    ? t('connectedServicesSetup.keyUse', {
                        name: selected.name!,
                      })
                    : t('connectedServicesSetup.keySaved')
                }
                disabled={!selected}
                onPress={() => {
                  if (selected)
                    props.onResult({
                      kind: 'selected',
                      secretRef: selected.ref,
                    });
                }}
              />
            </View>
          </RoundButtonSizeScope>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The sheet bounds its height; the mode switch, search and actions stay, the list or form scrolls between them.
  body: {
    gap: theme.space.s16,
    flexShrink: 1,
    minHeight: 0,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  keys: {
    gap: theme.space.s2,
    marginHorizontal: -theme.space.s8,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  mark: {
    width: ICON_SIZE.sm,
    alignItems: 'center',
  },
  approves: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
