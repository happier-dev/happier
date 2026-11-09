import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import type { PopoverAnchor } from '@/components/ui/popover';
import * as React from 'react';
import { Platform } from 'react-native';

import type {
  PluginContributionIdentityV1} from '@happier-dev/protocol/plugins/contribution-identity';
import type {
  VoiceProviderContribution,
  VoiceRawCredentialGrantDeclaration,
} from '@happier-dev/protocol/plugins/contributions/voice';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { Modal } from '@/modal';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import { sync } from '@/sync/sync';
import { requireOneShotAccountSettingsMutationApplied } from '@/sync/engine/settings/syncSettings';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  bindAccountVoiceCredentialSavedSecret,
  resolveExactAccountVoiceCredentialSecretId,
  resolveAccountVoiceCredential,
  resolveAccountVoiceCredentialSourceSelection,
  resolveAccountVoiceCredentialStatus,
  resolveSelectedVoiceCredentialRawGrants,
  type AccountVoiceCredentialSource,
  type AccountVoiceCredentialUseStatus,
} from './accountVoiceCredential';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { voiceCredentialSettingAnchor } from '@/voice/settings/voiceContributedSettingsDeclarations';
import {
  readSafeVoiceRuntimeFailureCode,
  recordVoiceRuntimeFailure,
  type VoiceRuntimeFailureOutcome,
} from '@/voice/runtime/voiceRuntimeFailureCode';
import { VoiceRawCredentialAccessReview } from './VoiceRawCredentialAccessReview';
import { projectVoiceCredentialAccessReviewRequirement } from './credentialReadiness';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * What the row can do with one credential slot. `useSavedSecret` points the
 * slot at a SavedSecret the account already stores; `enterNew` is the
 * key-entry gesture; `remove` unbinds it.
 */
type VoiceCredentialGesture = 'useSavedSecret' | 'enterNew' | 'remove';

/**
 * Sole record for a Voice credential gesture that changed nothing.
 *
 * The gesture's only other report is a modal, and a modal mounted while the
 * surface that opened it is unmounting can be dismissed before it is read. A
 * console record is the one report that survives that, and without it a
 * credential the user explicitly selected can fail to bind with no trace
 * anywhere. Only safe codes are recorded; no secret material is.
 */
function recordVoiceCredentialGestureFailure(
  contribution: PluginContributionIdentityV1 | null,
  gesture: VoiceCredentialGesture,
  outcome: VoiceRuntimeFailureOutcome,
  reason: string,
): void {
  recordVoiceRuntimeFailure(
    contribution ? buildQualifiedPluginContributionKey(contribution) : 'unavailable',
    outcome,
    `voice_credential:${gesture}`,
    reason,
  );
}

async function reportVoiceCredentialMutationOutcomeUnknown(
  contribution: PluginContributionIdentityV1 | null,
  gesture: VoiceCredentialGesture,
  reason: string,
): Promise<void> {
  recordVoiceCredentialGestureFailure(contribution, gesture, 'unapplied', reason);
  await Modal.alertAsync(
    t('common.error'),
    t('settingsProviders.errors.mutationOutcomeUnknownDescription'),
  );
}

/**
 * Lets an in-flight web click finish against the surface that owns it before a
 * nested overlay mounts; otherwise the new overlay can treat that same click as
 * an outside press and dismiss itself before the user ever sees it.
 */
async function settleWebOverlayHandoff(): Promise<void> {
  if (Platform.OS !== 'web') return;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type VoiceCredentialItemStatus = Readonly<{
  status: AccountVoiceCredentialUseStatus;
  /** Whether the selected SavedSecret still exists. */
  exists: boolean;
  /** Whether the selected SavedSecret material is ready. */
  usable: boolean;
  source: AccountVoiceCredentialSource | null;
  credentialIdentity: string | null;
}>;

/** Trusted account-settings surface for one canonical SavedSecret slot binding. */
export const VoiceCredentialItem = React.memo(function VoiceCredentialItem(props: Readonly<{
  testID?: string;
  title: string;
  promptTitle: string;
  promptDescription: string;
  contribution: PluginContributionIdentityV1 | null;
  credentialSlotId: string;
  credentialSourcePurpose?: string;
  credentialSourceDeclaration?: VoiceProviderContribution;
  rawCredentialReviewGrants?: readonly VoiceRawCredentialGrantDeclaration[];
  machineId?: string | null;
  machineLabel?: string | null;
  disclosePlainStorage: boolean;
  onChanged?: () => void;
  onStatusChanged?: (status: VoiceCredentialItemStatus) => void;
}>) {
  const voiceSettingsV1 = useSetting('voiceSettingsV1');
  const secrets = useSetting('secrets');
  const settings = React.useMemo(() => ({ voiceSettingsV1, secrets }), [voiceSettingsV1, secrets]);
  const expectedSettingsScope = useAccountSettingsScope();
  const credentialAction = useMountedActionExecution(expectedSettingsScope);
  const purposes = useConnectedAccountCatalog('purposes', expectedSettingsScope);
  const connectedPurposes = purposes.status === 'ready' && !purposes.stale ? purposes.value : null;
  const savedSecretCatalog = useSavedSecretCatalog();
  const [gestureMenuOpen, setGestureMenuOpen] = React.useState(false);
  const readCurrentSettings = () => {
    const current = storage.getState();
    if (!areAccountSettingsScopesEqual(expectedSettingsScope, current.settingsScope)) {
      throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
    }
    return current;
  };
  const credentialStatus = props.contribution
    ? resolveAccountVoiceCredentialStatus({
        settings,
        contribution: props.contribution,
        credentialSlotId: props.credentialSlotId,
        machineId: props.machineId,
        resolveSavedSecret: savedSecretCatalog.resolveReference,
      })
    : Object.freeze({ status: 'missing' as const, reference: null });
  const reference = credentialStatus.reference;
  const status = React.useMemo(() => ({
    status: credentialStatus.status,
    exists: reference !== null,
    usable: credentialStatus.status === 'ready',
    source: reference?.source ?? null,
    credentialIdentity: reference?.secretId ?? null,
  }), [credentialStatus.status, reference?.secretId, reference?.source]);

  React.useEffect(() => props.onStatusChanged?.(status), [props.onStatusChanged, status]);

  const detail = credentialStatus.status === 'unknown'
    // The snapshot could not be resolved. "Not saved to your account" would be
    // a claim about stored state this read never managed to observe.
    ? tLoose('voice.readiness.credential_unknown')
    : reference
      ? reference.source === 'machine_override' && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.setOnMachineOverride', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.setOnAccount')
      : props.machineId && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.notSetWithFallback', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.notSetOnAccount');

  // A readable catalog with usable records can offer Saved Secret selection.
  const offersSavedSecretSelection = Boolean(props.contribution)
    && credentialStatus.status !== 'unknown'
    // A snapshot without a readable secret collection offers nothing to select.
    && savedSecretCatalog.entries.some((entry) => entry.capabilities.use);

  const runReferenceGesture = async (operation: 'bind' | 'remove',
    expectedSecretId: string | null, expectedSecretUpdatedAt: number | null, secretId?: string) => {
    const expectedSettingsVersion = readCurrentSettings().settingsVersion;
    const contribution = props.contribution;
    const current = contribution ? voiceProviderRegistry.get(buildQualifiedPluginContributionKey(contribution)) : null;
    const declaration = props.credentialSourceDeclaration ?? (current && 'declaration' in current ? current.declaration : null);
    const anchor = contribution && declaration ? voiceCredentialSettingAnchor(contribution, declaration, 'credential') : null;
    if (expectedSettingsVersion === null || !anchor) throw Object.assign(new Error('voice_credential_source_declaration_unavailable'), { code: 'voice_credential_source_declaration_unavailable' });
    const result = await credentialAction.execute('settings.invoke', { anchor, input: {
      kind: 'voice_saved_secret', operation, credentialSlotId: props.credentialSlotId, machineId: props.machineId ?? null,
      expectedSettingsVersion, expectedSecretId, expectedSecretUpdatedAt,
      ...(secretId ? { secretId } : {}),
    } }, { retainInvocation: true });
    if (!result.ok) throw Object.assign(new Error('voice_credential_operation_failed'), { code: result.errorCode });
    const receipt = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(result.result);
    if (receipt.status === 'cancelled') return 'cancelled';
    if (receipt.status !== 'completed' || !receipt.value || typeof receipt.value !== 'object' || Array.isArray(receipt.value)
      || !('status' in receipt.value)) throw new Error('voice_credential_operation_unavailable');
    const status = receipt.value.status;
    if (status === 'conflict') throw Object.assign(new Error('voice_credential_source_conflict'), { code: 'voice_credential_source_conflict' });
    if (status !== 'applied' && status !== 'outcomeUnknown') throw new Error('voice_credential_operation_unavailable');
    if (status === 'outcomeUnknown') {
      await reportVoiceCredentialMutationOutcomeUnknown(contribution,
        operation === 'bind' ? 'useSavedSecret' : operation === 'remove' ? 'remove' : 'enterNew',
        operation === 'bind' ? 'saved_secret_binding_outcome_unknown' : 'saved_secret_mutation_outcome_unknown');
    }
    return status;
  };

  const runCredentialGesture = (gesture: VoiceCredentialGesture, anchor?: PopoverAnchor) => fireAndForget((async () => {
      try {
        if (credentialAction.approval.approvalPending) return;
        const contribution = props.contribution;
        if (!contribution) {
          throw Object.assign(new Error('voice_credential_target_unavailable'), {
            code: 'voice_credential_target_unavailable',
          });
        }
        // Let the opener click finish against the settings route before mounting a
        // nested modal; otherwise the new overlay can dismiss the route as "outside".
        await settleWebOverlayHandoff();

        const expectedSecretId = resolveExactAccountVoiceCredentialSecretId({
          settings: readCurrentSettings().settings,
          contribution,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
        });
        const expectedSavedSecret = expectedSecretId
          ? savedSecretCatalog.resolveReference(expectedSecretId)
          : null;
        const expectedSecretUpdatedAt = expectedSavedSecret?.revision ?? null;
        if (gesture === 'remove') {
          if (!expectedSecretId || expectedSecretUpdatedAt === null) {
            // The row only offers Remove for a bound slot, so this is a slot
            // whose record the account no longer stores. Removal cannot name it
            // and silently did nothing; binding or entering a key repairs it.
            recordVoiceCredentialGestureFailure(
              contribution,
              gesture,
              'unapplied',
              expectedSecretId ? 'saved_secret_record_missing' : 'voice_credential_not_bound',
            );
            return;
          }
          if (await runReferenceGesture('remove', expectedSecretId, expectedSecretUpdatedAt) !== 'applied') return;
          props.onChanged?.();
          return;
        }
        const selection = await presentConnectSheet({
          scope: expectedSettingsScope,
          anchor,
          service: { kind: 'key', keyKind: 'apiKey', suggestedName: props.title },
          bindingTarget: { kind: 'voice', contribution, slot: props.credentialSlotId },
          ...(expectedSecretId ? { current: expectedSecretId } : {}),
        });
        if (selection.kind === 'dismissed') return;
        const selectedSecretId = selection.secretRef;
        if (selection.kind === 'connected' && !props.credentialSourcePurpose) {
          // Adding a dormant slot must preserve the selected Connected Account.
          // The sheet already created the resource; this writer only links its reference.
          const expectedSettingsVersion = readCurrentSettings().settingsVersion;
          if (expectedSettingsVersion === null) throw new Error('account_settings_version_unavailable');
          const result = await sync.mutateAccountSettingsOnce({
            expectedSettingsScope,
            expectedSettingsVersion,
            mutate: raw => ({
              settings: bindAccountVoiceCredentialSavedSecret({
                settings: settingsParse(raw), contribution,
                credentialSlotId: props.credentialSlotId, machineId: props.machineId,
                secretId: selectedSecretId, expectedSecretId, expectedSecretUpdatedAt,
              }).accountSettings,
              value: undefined,
            }),
          });
          if (result.status === 'outcomeUnknown') {
            await reportVoiceCredentialMutationOutcomeUnknown(contribution, gesture, 'saved_secret_binding_outcome_unknown');
            return;
          }
          requireOneShotAccountSettingsMutationApplied(result);
          props.onChanged?.();
          return;
        }
        // Connect owns creation and storage disclosure; this handler links its reference.
        // An explicit selection always writes the state it asserts, including
        // when the slot already names this record: the row reports the source
        // that is in effect, and a slot can hold an id whose source is dormant
        // or whose record is gone. Re-asserting it is idempotent at the owner
        // and is the only gesture that can repair either state.
        // Both paths are checked against the same question the row asks:
        // does this slot now USE the chosen record?
        const usesSelectedSecret = (produced: Settings): boolean => resolveAccountVoiceCredential(
          produced,
          contribution,
          props.credentialSlotId,
          props.machineId,
        )?.secretId === selectedSecretId;
        const selectionOutcome = await runReferenceGesture('bind', expectedSecretId, expectedSecretUpdatedAt, selectedSecretId);
        if (selectionOutcome === 'cancelled') {
          recordVoiceCredentialGestureFailure(contribution, gesture, 'unapplied', 'operation_cancelled');
          return;
        }
        if (selectionOutcome === 'outcomeUnknown') {
          return;
        }
        // The reducer agreeing is not the same as the account agreeing. An
        // account-settings write whose outgoing state equals the stored state
        // is reported as applied WITHOUT issuing a request, and the canonical
        // store is then re-projected from that stored state — so a slot the
        // store does not consider bound stays unbound while every repeat of
        // this gesture keeps reporting success and sending nothing. Read the
        // canonical snapshot the write left behind (the engine applies it
        // before it returns) rather than trusting the reported status.
        const storedAfterWrite = storage.getState().settings;
        if (selectionOutcome !== 'applied' || !usesSelectedSecret(storedAfterWrite)) {
          // The write reported success but the slot does not use the chosen
          // record — the state the row reports and the state the write asserts
          // have diverged, and repeating the gesture cannot converge them.
          recordVoiceCredentialGestureFailure(
            contribution,
            gesture,
            'unapplied',
            'saved_secret_binding_not_effective',
          );
          await Modal.alertAsync(
            t('common.error'),
            t('settingsVoice.local.voiceCredential.operationFailed'),
          );
          return;
        }
        props.onChanged?.();
      } catch (error) {
        // Recorded before the alert, never instead of it: the alert is an
        // overlay mounted while another one is closing, so it is exactly the
        // report that can be dismissed before it is read.
        recordVoiceCredentialGestureFailure(
          props.contribution,
          gesture,
          'failed',
          readSafeVoiceRuntimeFailureCode(error) ?? 'voice_credential_gesture_failed',
        );
        await Modal.alertAsync(t('common.error'), t('settingsVoice.local.voiceCredential.operationFailed'));
      }
    })(), {
      tag: `VoiceCredentialItem.${props.contribution
        ? buildQualifiedPluginContributionKey(props.contribution)
        : 'unavailable'}.${props.credentialSlotId}`,
    });

  // The Connect sheet holds both ways to add a key (a new one or a saved one), so the row offers one
  // gesture for it; a linked key adds Remove beside Replace.
  const gestureItems: readonly DropdownMenuItem[] = [
    {
      id: 'useSavedSecret',
      title: t('secrets.actions.replace'),
    },
    {
      id: 'remove',
      title: t('common.remove'),
    },
  ];

  const credentialItem = offersSavedSecretSelection && reference
    ? <DropdownMenu
      testID={props.testID}
      open={gestureMenuOpen}
      onOpenChange={setGestureMenuOpen}
      variant="selectable"
      search={false}
      selectedId={null}
      allowEmptySelection
      showCategoryTitles={false}
      matchTriggerWidth
      connectToTrigger
      rowKind="item"
      itemTrigger={{
        title: props.title,
        subtitle: detail,
        showSelectedSubtitle: false,
        itemProps: { subtitleLines: 0 },
      }}
      items={gestureItems}
      onSelect={(id, selection) => {
        setGestureMenuOpen(false);
        if (id !== 'useSavedSecret' && id !== 'remove') return;
        runCredentialGesture(id, selection?.anchor);
      }}
    />
    : <Item
      testID={props.testID}
      title={props.title}
      subtitle={detail}
      subtitleLines={0}
      onPress={(event) => runCredentialGesture(offersSavedSecretSelection ? 'useSavedSecret' : 'enterNew', resolvePressTriggerAnchor(event))}
    />;

  let selectedForRawReview = false;
  const rawCredentialReviewGrants = props.rawCredentialReviewGrants ?? [];
  if (
    props.contribution
    && props.credentialSourcePurpose
    && props.credentialSourceDeclaration
    && rawCredentialReviewGrants.length > 0
  ) {
    try {
      const source = resolveAccountVoiceCredentialSourceSelection({
        settings,
        connectedPurposes,
        contribution: props.contribution,
        credentialSlotId: props.credentialSlotId,
        purpose: {
          consumer: props.contribution,
          purpose: props.credentialSourcePurpose,
        },
        machineId: props.machineId ?? null,
      });
      const selectedGrants = resolveSelectedVoiceCredentialRawGrants({
        declaration: props.credentialSourceDeclaration,
        contribution: props.contribution,
        selection: source.selection,
      });
      selectedForRawReview = source.selection.kind === 'savedSecret'
        && rawCredentialReviewGrants.some((rawGrant) => (
          selectedGrants.some((grant) => JSON.stringify(grant) === JSON.stringify(rawGrant))
        ));
    } catch {
      selectedForRawReview = false;
    }
  }
  if (!props.contribution || !selectedForRawReview) {
    return credentialItem;
  }

  return (
    <>
      {credentialItem}
      {rawCredentialReviewGrants.map((rawGrant, index) => (
        <VoiceRawCredentialAccessReview
          key={JSON.stringify(rawGrant)}
          contribution={props.contribution!}
          grantRequirement={projectVoiceCredentialAccessReviewRequirement(credentialStatus)}
          rawGrant={rawGrant}
          testID={props.testID
            ? `${props.testID}-raw-credential-access${index === 0 ? '' : `-${index}`}`
            : undefined}
        />
      ))}
    </>
  );
});
