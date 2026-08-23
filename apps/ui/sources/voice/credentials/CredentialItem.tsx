import * as React from 'react';
import { Platform } from 'react-native';

import type {
  AccountSettingsSavedSecretMutation,
  AccountSettingsVoiceCredentialSourceMutationResult,
  PluginContributionIdentityV1,
  RecipientContractV1,
  VoiceProviderContribution,
} from '@happier-dev/protocol';
import {
  buildQualifiedPluginContributionKey,
  resolveRequiredRecipientContractApprovalDigestV1,
} from '@happier-dev/protocol';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SavedSecretPickerModal } from '@/components/ui/forms/valueRefs/SavedSecretPickerModal';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage, useSettings } from '@/sync/domains/state/storage';
import { useSettingsVersion } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import { t, tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  approveAccountVoiceCredentialRecipientContract,
  bindAccountVoiceCredentialSavedSecret,
  createAccountVoiceCredentialBindingMutation,
  createAccountVoiceCredentialReplacementMutation,
  mutateAccountVoiceCredentialSource,
  removeAccountVoiceCredential,
  resolveExactAccountVoiceCredentialSecretId,
  resolveAccountVoiceCredential,
  resolveAccountVoiceCredentialStatus,
  upsertAccountVoiceCredential,
  type AccountVoiceCredentialSource,
  type AccountVoiceCredentialUseStatus,
} from './accountVoiceCredential';
import { confirmAccountVoiceCredentialWrite } from './confirmAccountVoiceCredentialWrite';
import { createRecipientContractApproval } from './recipientContractApprovalSummary';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import {
  readSafeVoiceRuntimeFailureCode,
  recordVoiceRuntimeFailure,
  type VoiceRuntimeFailureOutcome,
} from '@/voice/runtime/voiceRuntimeFailureCode';
import { VoiceRawCredentialAccessReview } from './VoiceRawCredentialAccessReview';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

export function voiceCredentialDeclarationHasRawGrants(
  declaration: VoiceProviderContribution | undefined,
): boolean {
  return declaration?.credentials?.sources.some((source) => (source.rawGrants?.length ?? 0) > 0) === true;
}

/**
 * What the row can do with one credential slot. `useSavedSecret` points the
 * slot at a SavedSecret the account already stores; `enterNew` is the
 * key-entry gesture; `remove` unbinds it.
 */
type VoiceCredentialGesture = 'useSavedSecret' | 'enterNew' | 'remove';

/**
 * What the saved-secret picker returned.
 *
 * A selection and a dismissal both close the surface, so collapsing them into
 * `string | null` made "the user chose this record" indistinguishable from
 * "the user closed the sheet" — and the caller could only treat both as
 * nothing to do. Every branch below depends on telling them apart.
 */
type SavedSecretPick =
  | Readonly<{ kind: 'selected'; secretId: string }>
  | Readonly<{ kind: 'dismissed' }>;

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
  /** Whether the selected SavedSecret still exists, independently of approval. */
  exists: boolean;
  /** Whether the current recipient contract may materialize the SavedSecret. */
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
  recipientContract?: RecipientContractV1 | null;
  recipientContractDigest?: string | null;
  machineId?: string | null;
  machineLabel?: string | null;
  disclosePlainStorage: boolean;
  onChanged?: () => void;
  onStatusChanged?: (status: VoiceCredentialItemStatus) => void;
}>) {
  const settings = useSettings();
  const settingsVersion = useSettingsVersion();
  const [gestureMenuOpen, setGestureMenuOpen] = React.useState(false);
  const latestSettingsRef = React.useRef(settings);
  latestSettingsRef.current = settings;
  const latestSettingsVersionRef = React.useRef(settingsVersion);
  latestSettingsVersionRef.current = settingsVersion;
  const recipientApproval = React.useMemo(() => {
    if (!props.recipientContract) return null;
    try {
      return createRecipientContractApproval(props.recipientContract);
    } catch {
      return null;
    }
  }, [props.recipientContract]);
  // What a stored approval must still match before the credential may be used.
  // A first-party bundled recipient carries no such fence, so a release that
  // changes its mediated operations does not revoke an existing approval. The
  // disclosure itself is unchanged: it is driven by the contract's presence.
  const requiredRecipientContractDigest = props.recipientContract
    ? resolveRequiredRecipientContractApprovalDigestV1(props.recipientContract)
    : props.recipientContractDigest ?? null;
  const credentialStatus = props.contribution
    ? resolveAccountVoiceCredentialStatus({
        settings,
        contribution: props.contribution,
        credentialSlotId: props.credentialSlotId,
        machineId: props.machineId,
        requiredRecipientContractDigest,
      })
    : Object.freeze({ status: 'missing' as const, reference: null });
  const reference = credentialStatus.reference;
  const recipientApprovalRequired = credentialStatus.status === 'review_required';
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
    : recipientApprovalRequired
    ? t('settingsVoice.externalCredentials.reviewRequired')
    : reference
      ? reference.source === 'machine_override' && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.setOnMachineOverride', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.setOnAccount')
      : props.machineId && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.notSetWithFallback', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.notSetOnAccount');

  // A slot can only offer selection when the account actually stores secrets and
  // the current snapshot was readable; approval-pending slots keep their single
  // approval gesture.
  const offersSavedSecretSelection = Boolean(props.contribution)
    && !recipientApprovalRequired
    && credentialStatus.status !== 'unknown'
    // A snapshot without a readable secret collection offers nothing to select.
    && Array.isArray(settings.secrets)
    && settings.secrets.length > 0;

  const runVoiceCredentialSourceMutation = async (
    contribution: PluginContributionIdentityV1,
    savedSecretMutation: Extract<
      AccountSettingsSavedSecretMutation,
      Readonly<{ kind: 'replaceVoiceCredentialSecret' }>
      | Readonly<{ kind: 'bindVoiceCredentialSavedSecret' }>
    >,
    /**
     * Receives the settings the reducer actually produced. The mutation result
     * reports the Connected-Account purpose binding, not the credential slot,
     * so this is the only place the caller can see whether the slot ended up
     * using the record it asked for.
     */
    observeProducedSettings?: (produced: Settings) => void,
  ): Promise<AccountSettingsVoiceCredentialSourceMutationResult> => {
    const expectedSettingsVersion = latestSettingsVersionRef.current;
    const currentEntry = voiceProviderRegistry.get(
      buildQualifiedPluginContributionKey(contribution),
    );
    const expectedDeclaration = props.credentialSourceDeclaration
      ?? (currentEntry?.kind === 'voice.conversation-provider.v1'
        || currentEntry?.kind === 'voice.speech-engine.v1'
        ? currentEntry.declaration ?? null
        : null);
    if (expectedSettingsVersion === null || !expectedDeclaration) {
      throw Object.assign(new Error('voice_credential_source_declaration_unavailable'), {
        code: 'voice_credential_source_declaration_unavailable',
      });
    }
    const result = await mutateAccountVoiceCredentialSource({
      mutation: {
        contribution,
        credentialSlotId: props.credentialSlotId,
        selection: { kind: 'savedSecret' },
        expectedSettingsVersion,
        savedSecretMutation,
      },
      expectedDeclaration,
      resolveCurrentDeclaration: (currentContribution) => {
        const current = voiceProviderRegistry.get(
          buildQualifiedPluginContributionKey(currentContribution),
        );
        return current?.kind === 'voice.conversation-provider.v1'
          || current?.kind === 'voice.speech-engine.v1'
          ? current.declaration ?? null
          : null;
      },
      mutateAccountSettingsOnce: observeProducedSettings
        ? (input) => sync.mutateAccountSettingsOnce({
            ...input,
            mutate: (raw) => {
              const produced = input.mutate(raw);
              observeProducedSettings(settingsParse(produced.settings));
              return produced;
            },
          })
        : sync.mutateAccountSettingsOnce,
    });
    if (result.status === 'conflict') {
      throw Object.assign(new Error('voice_credential_source_conflict'), {
        code: 'voice_credential_source_conflict',
      });
    }
    return result;
  };

  const pickStoredSavedSecretId = async (
    currentSecretId: string | null,
  ): Promise<SavedSecretPick> => await new Promise<SavedSecretPick>((resolve) => {
    let settled = false;
    const settle = (pick: SavedSecretPick) => {
      if (settled) return;
      settled = true;
      resolve(pick);
    };
    Modal.show({
      component: SavedSecretPickerModal,
      props: {
        selectedId: currentSecretId,
        // Removal and entering a new key are this row's own gestures; the
        // picker stays a selector over what the account already stores, so it
        // cannot create, rename, replace or delete a record from in here.
        includeNoneRow: false,
        allowAdd: false,
        allowEdit: false,
        onSelectId: (secretId) => settle(secretId
          ? { kind: 'selected', secretId }
          : { kind: 'dismissed' }),
      },
      chrome: {
        kind: 'card',
        title: t('settingsVoice.local.voiceCredential.useSavedSecretTitle'),
        subtitle: props.title,
        dimensions: { size: 'lg' },
      },
      closeOnBackdrop: true,
      onRequestClose: () => settle({ kind: 'dismissed' }),
      onHostUnmount: () => settle({ kind: 'dismissed' }),
    });
  });

  const runCredentialGesture = (gesture: VoiceCredentialGesture) => fireAndForget((async () => {
      try {
        const contribution = props.contribution;
        if (!contribution) {
          throw Object.assign(new Error('voice_credential_target_unavailable'), {
            code: 'voice_credential_target_unavailable',
          });
        }
        // Let the opener click finish against the settings route before mounting a
        // nested modal; otherwise the new overlay can dismiss the route as "outside".
        await settleWebOverlayHandoff();

        const current = resolveAccountVoiceCredential(
          latestSettingsRef.current,
          contribution,
          props.credentialSlotId,
          props.machineId,
        );
        const expectedSecretId = resolveExactAccountVoiceCredentialSecretId({
          settings: latestSettingsRef.current,
          contribution,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
        });
        const expectedSecretUpdatedAt = expectedSecretId
          ? latestSettingsRef.current.secrets.find(
              (candidate) => candidate.id === expectedSecretId,
            )?.updatedAt ?? null
          : null;
        const approvalRequiredNow = resolveAccountVoiceCredentialStatus({
          settings: latestSettingsRef.current,
          contribution,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
          requiredRecipientContractDigest,
        }).status === 'review_required';
        if (approvalRequiredNow) {
          if (!recipientApproval
            || !expectedSecretId
            || expectedSecretUpdatedAt === null
            || !requiredRecipientContractDigest
            || requiredRecipientContractDigest !== recipientApproval.digest) {
            throw Object.assign(new Error('invalid_voice_recipient_contract_approval'), {
              code: 'invalid_voice_recipient_contract_approval',
            });
          }
          if (!await Modal.confirm(
            t('settingsVoice.externalCredentials.recipientApprovalTitle'),
            recipientApproval.summary,
            { confirmText: t('settingsVoice.externalCredentials.recipientApprovalConfirm') },
          )) return;
          await sync.mutateAccountSettings((raw) =>
            approveAccountVoiceCredentialRecipientContract({
              settings: settingsParse(raw),
              contribution,
              credentialSlotId: props.credentialSlotId,
              machineId: props.machineId,
              expectedSecretId,
              expectedSecretUpdatedAt,
              approvedRecipientContractDigest: recipientApproval.digest,
            }).accountSettings);
          props.onChanged?.();
          return;
        }
        const confirmRecipientContract = async (): Promise<boolean> => {
          if (!props.recipientContract && !props.recipientContractDigest) return true;
          // `props.recipientContractDigest` is this same contract's digest,
          // produced by this same function at the registry entry, so comparing
          // the two can only ever agree. The contract failing to normalize into
          // an approval is the real unapprovable case.
          if (!recipientApproval) {
            throw Object.assign(new Error('invalid_voice_recipient_contract_approval'), {
              code: 'invalid_voice_recipient_contract_approval',
            });
          }
          const approved = await Modal.confirm(
            t('settingsVoice.externalCredentials.recipientApprovalTitle'),
            recipientApproval.summary,
            { confirmText: t('settingsVoice.externalCredentials.recipientApprovalConfirm') },
          );
          if (!approved) {
            // Also the only report when the confirm never reached the user:
            // a dismissed approval and a declined one are the same `false`.
            recordVoiceCredentialGestureFailure(
              contribution,
              gesture,
              'declined',
              'recipient_contract_not_approved',
            );
          }
          return approved;
        };
        if (gesture === 'useSavedSecret') {
          const pick = await pickStoredSavedSecretId(expectedSecretId);
          if (pick.kind === 'dismissed') {
            // A cancel and a row press the surface never delivered close the
            // picker identically, so this is the only observable that separates
            // them. Without it, a picker whose rows do not receive the press is
            // indistinguishable from a user who changed their mind — which is
            // exactly how this gesture failed silently across four sessions.
            recordVoiceCredentialGestureFailure(
              contribution,
              gesture,
              'unapplied',
              'saved_secret_selection_dismissed',
            );
            return;
          }
          const selectedSecretId = pick.secretId;
          // The picker's own dismissal is still settling this click; give it the
          // same handoff the opener got before mounting the approval confirm.
          await settleWebOverlayHandoff();
          // No new secret material is written here, so the plaintext-storage
          // disclosure that guards entering a key does not apply: the account
          // already stores this record under the terms it was saved with.
          if (!await confirmRecipientContract()) return;
          // An explicit selection always writes the state it asserts, including
          // when the slot already names this record: the row reports the source
          // that is in effect, and a slot can hold an id whose source is dormant
          // or whose record is gone. Re-asserting it is idempotent at the owner
          // and is the only gesture that can repair either state.
          const binding = {
            contribution,
            credentialSlotId: props.credentialSlotId,
            machineId: props.machineId,
            secretId: selectedSecretId,
            expectedSecretId,
            expectedSecretUpdatedAt,
            ...(recipientApproval
              ? { approvedRecipientContractDigest: recipientApproval.digest }
              : {}),
          };
          // Both paths are checked against the same question the row asks:
          // does this slot now USE the chosen record?
          const usesSelectedSecret = (produced: Settings): boolean => resolveAccountVoiceCredential(
            produced,
            contribution,
            props.credentialSlotId,
            props.machineId,
          )?.secretId === selectedSecretId;
          const selectionOutcome = await (async (): Promise<
            'effective' | 'notEffective' | 'outcomeUnknown'
          > => {
            let effective = false;
            if (props.credentialSourcePurpose) {
              const applied = await runVoiceCredentialSourceMutation(
                contribution,
                createAccountVoiceCredentialBindingMutation(binding),
                (produced) => { effective = usesSelectedSecret(produced); },
              );
              if (applied.status === 'outcomeUnknown') return 'outcomeUnknown';
              return applied.status === 'applied' && effective ? 'effective' : 'notEffective';
            }
            await sync.mutateAccountSettings((raw) => {
              const result = bindAccountVoiceCredentialSavedSecret({
                ...binding,
                settings: settingsParse(raw),
              });
              effective = usesSelectedSecret(result.settings);
              return result.accountSettings;
            });
            return effective ? 'effective' : 'notEffective';
          })();
          if (selectionOutcome === 'outcomeUnknown') {
            await reportVoiceCredentialMutationOutcomeUnknown(
              contribution,
              gesture,
              'saved_secret_binding_outcome_unknown',
            );
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
          if (selectionOutcome !== 'effective' || !usesSelectedSecret(storedAfterWrite)) {
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
          return;
        }
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
          if (!await Modal.confirm(
            t('settingsVoice.local.voiceCredential.deleteTitle'),
            t('settingsVoice.local.voiceCredential.deleteAccountBody'),
            { destructive: true, confirmText: t('common.remove') },
          )) return;
          await sync.mutateAccountSettings((raw) => removeAccountVoiceCredential({
            settings: settingsParse(raw),
            contribution,
            credentialSlotId: props.credentialSlotId,
            machineId: props.machineId,
            expectedSecretId,
            expectedSecretUpdatedAt,
          }).accountSettings);
          props.onChanged?.();
          return;
        }
        const entered = await Modal.prompt(
          props.promptTitle,
          current ? t('settingsVoice.local.voiceCredential.replaceOrRemoveBody') : props.promptDescription,
          { inputType: 'secure-text' },
        );
        if (entered === null) return;
        const secret = entered.trim();
        if (secret) {
          const permitted = await confirmAccountVoiceCredentialWrite({
            disclosePlainStorage: props.disclosePlainStorage,
            resolveAccountMode: async () => {
              const credentials = sync.getCredentials();
              if (!credentials) {
                throw Object.assign(new Error('account_credentials_unavailable'), {
                  code: 'account_credentials_unavailable',
                });
              }
              return (await fetchAccountEncryptionMode(credentials, { retry: 'none' })).mode;
            },
            confirm: async () => await Modal.confirm(
              t('settingsVoice.local.voiceCredential.plainStorageTitle'),
              t('settingsVoice.local.voiceCredential.plainStorageBody'),
              { confirmText: t('settingsVoice.local.voiceCredential.plainStorageConfirm') },
            ),
          });
          if (!permitted) return;
          if (!await confirmRecipientContract()) return;
          const mutationInput = {
            settings: latestSettingsRef.current,
            contribution,
            credentialSlotId: props.credentialSlotId,
            machineId: props.machineId,
            value: secret,
            generateId: randomUUID,
            now: Date.now(),
            expectedSecretId,
            expectedSecretUpdatedAt,
            ...(recipientApproval
              ? { approvedRecipientContractDigest: recipientApproval.digest }
              : {}),
          };
          if (props.credentialSourcePurpose) {
            const replacement = createAccountVoiceCredentialReplacementMutation({
              ...mutationInput,
              settings: latestSettingsRef.current,
            });
            const replacementResult = await runVoiceCredentialSourceMutation(
              contribution,
              replacement.mutation,
            );
            if (replacementResult.status === 'outcomeUnknown') {
              await reportVoiceCredentialMutationOutcomeUnknown(
                contribution,
                gesture,
                'saved_secret_replacement_outcome_unknown',
              );
              return;
            }
          } else {
            await sync.mutateAccountSettings((raw) => upsertAccountVoiceCredential({
              ...mutationInput,
              settings: settingsParse(raw),
            }).accountSettings);
          }
          props.onChanged?.();
          return;
        }
        if (!expectedSecretId || expectedSecretUpdatedAt === null) return;
        if (!await Modal.confirm(
          t('settingsVoice.local.voiceCredential.deleteTitle'),
          t('settingsVoice.local.voiceCredential.deleteAccountBody'),
          { destructive: true, confirmText: t('common.remove') },
        )) return;
        await sync.mutateAccountSettings((raw) => removeAccountVoiceCredential({
          settings: settingsParse(raw),
          contribution,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
          expectedSecretId,
          expectedSecretUpdatedAt,
        }).accountSettings);
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

  const gestureItems: readonly DropdownMenuItem[] = [
    {
      id: 'useSavedSecret',
      title: t('settingsVoice.local.voiceCredential.useSavedSecretTitle'),
      subtitle: t('settingsVoice.local.voiceCredential.useSavedSecretSubtitle'),
    },
    {
      id: 'enterNew',
      title: t('settingsVoice.local.voiceCredential.enterNewAction'),
    },
    ...(reference ? [{
      id: 'remove',
      title: t('common.remove'),
    }] : []),
  ];

  const credentialItem = offersSavedSecretSelection
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
        showSelectedSubtitle: false,
        detailFormatter: () => detail,
      }}
      items={gestureItems}
      onSelect={(id) => {
        setGestureMenuOpen(false);
        if (id !== 'useSavedSecret' && id !== 'enterNew' && id !== 'remove') return;
        runCredentialGesture(id);
      }}
    />
    : <Item
      testID={props.testID}
      title={props.title}
      detail={detail}
      onPress={() => runCredentialGesture('enterNew')}
    />;

  if (!props.contribution || !voiceCredentialDeclarationHasRawGrants(props.credentialSourceDeclaration)) {
    return credentialItem;
  }

  return (
    <>
      {credentialItem}
      <VoiceRawCredentialAccessReview
        contribution={props.contribution}
        testID={props.testID ? `${props.testID}-raw-credential-access` : undefined}
      />
    </>
  );
});
