import * as React from 'react';
import { Platform } from 'react-native';

import type { RecipientContractV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { settingsParse } from '@/sync/domains/settings/settings';
import { useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  approveAccountVoiceCredentialRecipientContract,
  isAccountVoiceCredentialRecipientApprovalRequired,
  removeAccountVoiceCredential,
  resolveExactAccountVoiceCredentialSecretId,
  resolveAccountVoiceCredential,
  upsertAccountVoiceCredential,
  type AccountVoiceCredentialSource,
} from './accountVoiceCredential';
import { confirmAccountVoiceCredentialWrite } from './confirmAccountVoiceCredentialWrite';
import { createRecipientContractApproval } from './recipientContractApprovalSummary';

/** Trusted account-settings surface for one canonical SavedSecret slot binding. */
export const VoiceCredentialItem = React.memo(function VoiceCredentialItem(props: Readonly<{
  testID?: string;
  title: string;
  promptTitle: string;
  promptDescription: string;
  providerId: string;
  credentialSlotId: string;
  recipientContract?: RecipientContractV1 | null;
  recipientContractDigest?: string | null;
  machineId?: string | null;
  machineLabel?: string | null;
  disclosePlainStorage: boolean;
  onChanged?: () => void;
  onStatusChanged?: (status: Readonly<{
    exists: boolean;
    source: AccountVoiceCredentialSource | null;
    credentialIdentity: string | null;
  }>) => void;
}>) {
  const settings = useSettings();
  const latestSettingsRef = React.useRef(settings);
  latestSettingsRef.current = settings;
  const recipientApproval = React.useMemo(() => {
    if (!props.recipientContract) return null;
    try {
      return createRecipientContractApproval(props.recipientContract);
    } catch {
      return null;
    }
  }, [props.recipientContract]);
  const requiredRecipientContractDigest = props.recipientContractDigest
    ?? recipientApproval?.digest
    ?? null;
  const reference = resolveAccountVoiceCredential(
    settings,
    props.providerId,
    props.credentialSlotId,
    props.machineId,
    requiredRecipientContractDigest,
  );
  const recipientApprovalRequired = isAccountVoiceCredentialRecipientApprovalRequired({
    settings,
    providerId: props.providerId,
    credentialSlotId: props.credentialSlotId,
    machineId: props.machineId,
    requiredRecipientContractDigest,
  });
  const status = React.useMemo(() => ({
    exists: reference !== null,
    source: reference?.source ?? null,
    credentialIdentity: reference?.secretId ?? null,
  }), [reference?.secretId, reference?.source]);

  React.useEffect(() => props.onStatusChanged?.(status), [props.onStatusChanged, status]);

  const detail = recipientApprovalRequired
    ? t('settingsVoice.externalCredentials.reviewRequired')
    : reference
      ? reference.source === 'machine_override' && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.setOnMachineOverride', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.setOnAccount')
      : props.machineId && props.machineLabel
        ? t('settingsVoice.local.voiceCredential.notSetWithFallback', { machine: props.machineLabel })
        : t('settingsVoice.local.voiceCredential.notSetOnAccount');

  return <Item
    testID={props.testID}
    title={props.title}
    detail={detail}
    onPress={() => fireAndForget((async () => {
      try {
        if (Platform.OS === 'web') {
          // Let the opener click finish against the settings route before mounting a
          // nested modal; otherwise the new overlay can dismiss the route as "outside".
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }

        const current = resolveAccountVoiceCredential(
          latestSettingsRef.current,
          props.providerId,
          props.credentialSlotId,
          props.machineId,
        );
        const expectedSecretId = resolveExactAccountVoiceCredentialSecretId({
          settings: latestSettingsRef.current,
          providerId: props.providerId,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
        });
        const expectedSecretUpdatedAt = expectedSecretId
          ? latestSettingsRef.current.secrets.find(
              (candidate) => candidate.id === expectedSecretId,
            )?.updatedAt ?? null
          : null;
        const approvalRequiredNow =
          isAccountVoiceCredentialRecipientApprovalRequired({
            settings: latestSettingsRef.current,
            providerId: props.providerId,
            credentialSlotId: props.credentialSlotId,
            machineId: props.machineId,
            requiredRecipientContractDigest,
          });
        if (approvalRequiredNow) {
          if (!recipientApproval
            || !expectedSecretId
            || expectedSecretUpdatedAt === null
            || !requiredRecipientContractDigest
            || requiredRecipientContractDigest !== recipientApproval.digest) {
            throw new Error('invalid_voice_recipient_contract_approval');
          }
          if (!await Modal.confirm(
            t('settingsVoice.externalCredentials.recipientApprovalTitle'),
            recipientApproval.summary,
            { confirmText: t('settingsVoice.externalCredentials.recipientApprovalConfirm') },
          )) return;
          await sync.mutateAccountSettings((raw) =>
            approveAccountVoiceCredentialRecipientContract({
              settings: settingsParse(raw),
              providerId: props.providerId,
              credentialSlotId: props.credentialSlotId,
              machineId: props.machineId,
              expectedSecretId,
              expectedSecretUpdatedAt,
              approvedRecipientContractDigest: recipientApproval.digest,
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
              if (!credentials) throw new Error('account_credentials_unavailable');
              return (await fetchAccountEncryptionMode(credentials, { retry: 'none' })).mode;
            },
            confirm: async () => await Modal.confirm(
              t('settingsVoice.local.voiceCredential.plainStorageTitle'),
              t('settingsVoice.local.voiceCredential.plainStorageBody'),
              { confirmText: t('settingsVoice.local.voiceCredential.plainStorageConfirm') },
            ),
          });
          if (!permitted) return;
          if (props.recipientContract || props.recipientContractDigest) {
            if (!recipientApproval
              || (props.recipientContractDigest
                && props.recipientContractDigest !== recipientApproval.digest)) {
              throw new Error('invalid_voice_recipient_contract_approval');
            }
            if (!await Modal.confirm(
              t('settingsVoice.externalCredentials.recipientApprovalTitle'),
              recipientApproval.summary,
              { confirmText: t('settingsVoice.externalCredentials.recipientApprovalConfirm') },
            )) return;
          }
          await sync.mutateAccountSettings((raw) => upsertAccountVoiceCredential({
            settings: settingsParse(raw),
            providerId: props.providerId,
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
          }).accountSettings);
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
          providerId: props.providerId,
          credentialSlotId: props.credentialSlotId,
          machineId: props.machineId,
          expectedSecretId,
          expectedSecretUpdatedAt,
        }).accountSettings);
        props.onChanged?.();
      } catch {
        await Modal.alertAsync(t('common.error'), t('settingsVoice.local.voiceCredential.operationFailed'));
      }
    })(), { tag: `VoiceCredentialItem.${props.providerId}.${props.credentialSlotId}` })}
  />;
});
