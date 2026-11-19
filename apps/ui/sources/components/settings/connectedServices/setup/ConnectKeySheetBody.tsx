import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SavedSecretCreateEditor } from '@/components/secrets/SavedSecretCreateEditor';
import { SavedSecretChoiceList } from '@/components/secrets/SavedSecretChoiceList';
import type { SavedSecretCatalogProjection } from '@/components/secrets/useSavedSecretCatalog';
import { ConnectedAccountGuide, type ConnectedAccountGuideContent } from '../account/ConnectedAccountGuide';
import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
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
    /** How to create this key, when what asked for it declares that; nothing to create for a saved one. */
    guide?: ConnectedAccountGuideContent | null;
    /** The primary's words for a requested key ("Save key"); a bare secret keeps "Save secret". */
    submitLabel?: string;
    onResult: (
      result: Readonly<{ kind: 'connected' | 'selected'; secretRef: string }>,
    ) => void;
    onCancel: () => void;
  }>,
) {
  const router = useRouter();
  const linkable = props.linkableEntries;
  const hasSaved = linkable.length > 0;
  const [chosenMode, setChosenMode] = React.useState<KeyMode | null>(null);
  const mode: KeyMode = !hasSaved ? 'new' : (chosenMode ?? props.initialMode);
  const [chosenRef, setChosenRef] = React.useState<string | null>(null);
  const selectedRef =
    chosenRef ??
    (linkable.some((entry) => entry.ref === props.preselected)
      ? props.preselected
      : null);
  const selected = linkable.find((entry) => entry.ref === selectedRef) ?? null;

  const sameTarget = React.useMemo(
    () => new Set(props.sameTargetRefs ?? []),
    [props.sameTargetRefs],
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

  // Why a row leads: in use here, or used elsewhere for the same thing; the order stays the presenter's.
  const rows = linkable.map((entry) => ({
    entry,
    note: props.currentRef && entry.ref === props.currentRef
      ? t('connectedServicesSetup.keyInUseHere')
      : sameTarget.has(entry.ref) ? t('connectedServicesSetup.keyUsedElsewhereForThis') : null,
  }));

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
          {props.guide ? <View style={styles.guide}><ConnectedAccountGuide guide={props.guide} /></View> : null}
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
          <SavedSecretChoiceList
            rows={rows}
            selectedRef={selectedRef}
            onChoose={setChosenRef}
            testIDPrefix="connect-key-sheet"
          />
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
  // The guide owns no outer space; the create form's first field sits one step under it.
  guide: {
    paddingBottom: theme.space.s12,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s8,
  },
}));
