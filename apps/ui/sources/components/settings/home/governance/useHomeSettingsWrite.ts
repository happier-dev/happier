import * as React from 'react';
import { validateServerConfigText } from '@happier-dev/protocol/serverConfig/serverConfigCodec';
import type {
  HomeSettingEntryV1,
  HomeSettingSecretWriteV1,
} from '@happier-dev/protocol/home/governance';

import type { HomeSettingsRead } from '@/hooks/home/useHomeSettings';
import { Modal } from '@/modal';
import {
  readHomeSettingsInvalidFailure,
  setHomeSettings,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { homeSettingRegistryEntry } from './homeSettingDeclaration';

/** A setting's registry bounds as words: "0–65535", "1 or more", "Up to 10". */
export function homeSettingBoundsLine(
  entry: HomeSettingEntryV1,
): string | null {
  const bounds = entry.declaration?.bounds;
  if (!bounds) return null;
  const { min, max } = bounds;
  if (min !== undefined && max !== undefined)
    return t('homeGovernance.features.rangeBetween', { min, max });
  if (min !== undefined)
    return t('homeGovernance.features.rangeAtLeast', { min });
  if (max !== undefined)
    return t('homeGovernance.features.rangeAtMost', { max });
  return null;
}

/** Why a typed value was refused, in the field: its bounds when it has them. */
export function homeSettingFieldError(
  entry: HomeSettingEntryV1,
  reason: 'out_of_bounds' | 'invalid',
): string {
  const bounds = homeSettingBoundsLine(entry);
  return reason === 'out_of_bounds' && bounds
    ? t('homeSettings.row.outOfBounds', { bounds })
    : t('homeSettings.row.invalid');
}

/** The typed text's own refusal reason from the registry codec, or `null` when it parses. */
export function homeSettingTextRefusal(
  entry: HomeSettingEntryV1,
  text: string,
): 'out_of_bounds' | 'invalid' | null {
  const registryEntry = homeSettingRegistryEntry(entry);
  if (!registryEntry || !text.trim()) return null;
  const parsed = validateServerConfigText(registryEntry, text.trim());
  if (parsed.ok) return null;
  return parsed.reason === 'out_of_bounds' ? 'out_of_bounds' : 'invalid';
}

export type HomeSettingsWriteRequest = Readonly<{
  /** The row a refusal is said on when the Home does not name one. */
  key: string | null;
  values: Readonly<Record<string, unknown>>;
  secrets?: Readonly<Record<string, HomeSettingSecretWriteV1>>;
  discardPendingRestart?: true;
}>;

/**
 * The one `home.settings.set` path of the registry-rendered console pages (Server settings, the
 * Sign-in platforms on Sign-in providers): a write against the revision the page read, whose answer
 * replaces the page's projection. A revision conflict reloads; a refused key is said on its row
 * through `onFieldError`; any other refusal is the governance notice.
 */
export function useHomeSettingsWrite(
  input: Readonly<{
    context: HomeAdministrationContext;
    home: HomeSettingsRead;
    onFieldError: (key: string, message: string | null) => void;
  }>,
): Readonly<{
  writing: boolean;
  write: (request: HomeSettingsWriteRequest) => Promise<boolean>;
}> {
  const { context, home, onFieldError } = input;
  const [writing, setWriting] = React.useState(false);
  const settingsRef = React.useRef(home.settings);
  settingsRef.current = home.settings;

  const write = React.useCallback(
    async (request: HomeSettingsWriteRequest): Promise<boolean> => {
      const current = settingsRef.current;
      if (!current) return false;
      setWriting(true);
      try {
        const outcome = await setHomeSettings({
          scope: context.scope,
          expectedRevision: current.revision,
          values: request.values,
          ...(request.secrets ? { secrets: request.secrets } : {}),
          ...(request.discardPendingRestart
            ? { discardPendingRestart: true as const }
            : {}),
        });
        if (outcome.kind === 'succeeded') {
          home.adoptSettings(outcome.value);
          if (request.key) onFieldError(request.key, null);
          return true;
        }
        if (outcome.kind === 'approval_pending') {
          context.requestApproval?.(outcome.artifactId);
          return false;
        }
        if (outcome.failure.code === 'home_settings_revision_conflict') {
          await Modal.alertAsync(
            t('homeSettings.page.conflictTitle'),
            t('homeSettings.page.conflictBody'),
          );
          home.reload();
          return false;
        }
        const invalid = readHomeSettingsInvalidFailure(outcome.failure);
        if (invalid) {
          const entry = current.entries.find(
            (candidate) => candidate.key === invalid.key,
          );
          onFieldError(
            invalid.key,
            entry
              ? homeSettingFieldError(
                  entry,
                  invalid.reason === 'out_of_bounds'
                    ? 'out_of_bounds'
                    : 'invalid',
                )
              : t('homeSettings.row.invalid'),
          );
          return false;
        }
        const notice = homeGovernanceFailureNotice(outcome.failure);
        await Modal.alertAsync(notice.title, notice.body);
        return false;
      } finally {
        setWriting(false);
      }
    },
    [context, home, onFieldError],
  );

  return { writing, write };
}
