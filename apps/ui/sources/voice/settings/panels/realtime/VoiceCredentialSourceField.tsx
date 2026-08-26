import * as React from 'react';

import type {
  PluginContributionIdentityV1,
  QualifiedConnectedAccountPurposeBindingTargetV1,
  VoiceCredentialDeclaration,
  VoiceCredentialSourceSelection,
  VoiceProviderContribution,
} from '@happier-dev/protocol';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';

import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { sync } from '@/sync/sync';
import { useProfile, useSettings, useSettingsVersion } from '@/sync/store/hooks';
import { tLoose } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
  useProjectedConnectedServicesRegistry,
  useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { presentQualifiedConnectedAccountTarget } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import {
  mutateAccountVoiceCredentialSource,
  resolveAccountVoiceCredentialSourceSelection,
} from '@/voice/credentials/accountVoiceCredential';
import { resolveVoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

type SourceRow = Readonly<{
  item: DropdownMenuItem;
  selection: VoiceCredentialSourceSelection;
  usable: boolean;
}>;

const NONE_SELECTION = Object.freeze({ kind: 'none' as const });
const voiceProviderRegistry = createDefaultVoiceProviderRegistry();
const EMPTY_CONNECTED_ACCOUNT_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({});

export type VoiceCredentialSourceFieldStatus = Readonly<{
  selection: VoiceCredentialSourceSelection;
  usable: boolean;
}>;

function sameService(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function qualifyService(
  service: string | PluginContributionIdentityV1,
  declaringPluginId: string,
): PluginContributionIdentityV1 {
  return typeof service === 'string'
    ? Object.freeze({ pluginId: declaringPluginId, localId: service })
    : service;
}

function targetId(target: QualifiedConnectedAccountPurposeBindingTargetV1): string {
  return target.kind === 'account'
    ? JSON.stringify(['account', target.account.service.pluginId, target.account.service.localId, target.account.accountId])
    : JSON.stringify(['group', target.service.pluginId, target.service.localId, target.groupId]);
}

function selectionId(selection: VoiceCredentialSourceSelection): string {
  return selection.kind === 'connectedAccount'
    ? targetId(selection.target)
    : selection.kind;
}

export function VoiceCredentialSourceField(props: Readonly<{
  contribution: PluginContributionIdentityV1;
  declaration: VoiceProviderContribution;
  credentials: VoiceCredentialDeclaration;
  popoverBoundaryRef?: React.RefObject<any> | null;
  onStatusChanged?: (status: VoiceCredentialSourceFieldStatus) => void;
  isCurrent?: () => boolean;
}>) {
  const settings = useSettings();
  const settingsVersion = useSettingsVersion();
  const profile = useProfile();
  const projectedConnectedServicesRegistry = useProjectedConnectedServicesRegistry();
  const localizePluginText = useProjectedPluginLocalizedTextResolver();
  const [open, setOpen] = React.useState(false);
  const [mutationOutcomeUnknown, setMutationOutcomeUnknown] = React.useState(false);
  const mountedRef = React.useRef(true);
  const mutationOperationRef = React.useRef(0);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationOperationRef.current += 1;
    };
  }, []);
  const purpose = React.useMemo(() => Object.freeze({
    consumer: props.contribution,
    purpose: props.credentials.slot.purpose,
  }), [props.contribution, props.credentials.slot.purpose]);
  const resolution = React.useMemo(() => {
    try {
      return resolveAccountVoiceCredentialSourceSelection({
        settings,
        contribution: props.contribution,
        credentialSlotId: props.credentials.slot.id,
        purpose,
        machineId: null,
      });
    } catch {
      return null;
    }
  }, [props.contribution, props.credentials.slot.id, purpose, settings]);
  const connectedSources = React.useMemo(
    () => props.credentials.sources.flatMap((source) => (
      source.kind === 'connectedAccount'
        ? [Object.freeze({
            ...source,
            service: qualifyService(source.service, props.contribution.pluginId),
          })]
        : []
    )),
    [props.contribution.pluginId, props.credentials.sources],
  );
  const declaredServices = React.useMemo(
    () => connectedSources.map((source) => source.service),
    [connectedSources],
  );
  const rows = React.useMemo<readonly SourceRow[]>(() => {
    const next: SourceRow[] = [{
      item: {
        id: 'none',
        title: tLoose('common.none'),
      },
      selection: NONE_SELECTION,
      usable: false,
    }];
    if (props.credentials.sources.some((source) => source.kind === 'savedSecret')) {
      next.push({
        item: {
          id: 'savedSecret',
          title: tLoose('settingsVoice.realtimeProviders.authentication.savedSecret.title'),
          subtitle: tLoose('settingsVoice.realtimeProviders.authentication.savedSecret.subtitle'),
        },
        selection: Object.freeze({ kind: 'savedSecret' }),
        usable: Boolean(resolution?.savedSecret),
      });
    }
    for (const account of profile.connectedAccountsV4 ?? []) {
      const source = connectedSources.find((candidate) => sameService(candidate.service, account.ref.service));
      if (!source) continue;
      const target = Object.freeze({
        kind: 'account' as const,
        account: account.ref,
      });
      const usable = resolveVoiceConnectedAccountTargetEligibility({
        target,
        declaredServices,
        accounts: profile.connectedAccountsV4 ?? [],
        groups: profile.connectedAccountGroupsV4 ?? [],
        resolveAuthentication: getConnectedAccountAuthentication,
      }) === 'usable';
      const presentation = presentQualifiedConnectedAccountTarget({
        target,
        accounts: profile.connectedAccountsV4 ?? [],
        groups: profile.connectedAccountGroupsV4 ?? [],
        labelsByKey: settings.connectedServicesProfileLabelByKey ?? EMPTY_CONNECTED_ACCOUNT_LABELS,
        serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
          projectedConnectedServicesRegistry,
          account.ref.service,
          tLoose,
          localizePluginText,
        ),
      });
      next.push({
        item: {
          id: targetId(target),
          title: presentation.primaryLabel,
          ...(presentation.secondaryLabel ? { subtitle: presentation.secondaryLabel } : {}),
          accessibilityLabel: presentation.accessibilityLabel,
          disabled: !usable,
        },
        selection: Object.freeze({ kind: 'connectedAccount', target }),
        usable,
      });
    }
    for (const group of profile.connectedAccountGroupsV4 ?? []) {
      const source = connectedSources.find((candidate) => sameService(candidate.service, group.ref.service));
      if (!source) continue;
      const target = Object.freeze({
        kind: 'group' as const,
        service: group.ref.service,
        groupId: group.ref.groupId,
      });
      const usable = resolveVoiceConnectedAccountTargetEligibility({
        target,
        declaredServices,
        accounts: profile.connectedAccountsV4 ?? [],
        groups: profile.connectedAccountGroupsV4 ?? [],
        resolveAuthentication: getConnectedAccountAuthentication,
      }) === 'usable';
      const presentation = presentQualifiedConnectedAccountTarget({
        target,
        accounts: profile.connectedAccountsV4 ?? [],
        groups: profile.connectedAccountGroupsV4 ?? [],
        labelsByKey: settings.connectedServicesProfileLabelByKey ?? EMPTY_CONNECTED_ACCOUNT_LABELS,
        serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
          projectedConnectedServicesRegistry,
          group.ref.service,
          tLoose,
          localizePluginText,
        ),
      });
      next.push({
        item: {
          id: targetId(target),
          title: presentation.primaryLabel,
          ...(presentation.secondaryLabel ? { subtitle: presentation.secondaryLabel } : {}),
          accessibilityLabel: presentation.accessibilityLabel,
          disabled: !usable,
        },
        selection: Object.freeze({ kind: 'connectedAccount', target }),
        usable,
      });
    }
    const selected = resolution?.selection;
    if (selected?.kind === 'connectedAccount' && !next.some((row) => row.item.id === targetId(selected.target))) {
      next.push({
        item: {
          id: targetId(selected.target),
          title: tLoose('common.unavailable'),
          disabled: true,
        },
        selection: selected,
        usable: false,
      });
    }
    return Object.freeze(next);
  }, [
    connectedSources,
    declaredServices,
    localizePluginText,
    profile.connectedAccountGroupsV4,
    profile.connectedAccountsV4,
    projectedConnectedServicesRegistry,
    props.credentials.sources,
    resolution,
    settings.connectedServicesProfileLabelByKey,
  ]);
  const selected = resolution?.selection ?? NONE_SELECTION;
  // A null resolution means the stored selection could not be read, not that
  // the user selected nothing. Selecting `none` as current would present the
  // "—" row as an explicit choice and hide that the snapshot is unresolved;
  // re-picking a source here is the repair, so every row stays selectable.
  const selectedId = resolution ? selectionId(selected) : '';
  const selectedRow = rows.find((row) => row.item.id === selectedId) ?? null;
  const status = React.useMemo<VoiceCredentialSourceFieldStatus>(() => Object.freeze({
    selection: selected,
    usable: selected.kind === 'savedSecret'
      ? Boolean(resolution?.savedSecret)
      : selectedRow?.usable === true,
  }), [resolution?.savedSecret, selected, selectedRow?.usable]);
  React.useEffect(() => {
    props.onStatusChanged?.(status);
  }, [props.onStatusChanged, status]);

  return <DropdownMenu
    testID={`voice-credential-source-${props.credentials.slot.id}`}
    open={open}
    onOpenChange={setOpen}
    variant="selectable"
    search={rows.length > 8}
    selectedId={selectedId}
    showCategoryTitles={false}
    matchTriggerWidth
    connectToTrigger
    rowKind="item"
    popoverBoundaryRef={props.popoverBoundaryRef}
    itemTrigger={{
      title: tLoose('settingsVoice.realtimeProviders.authentication.title'),
      subtitle: mutationOutcomeUnknown
        ? tLoose('settingsProviders.errors.mutationOutcomeUnknownDescription')
        : tLoose('settingsVoice.realtimeProviders.authentication.subtitle'),
      showSelectedSubtitle: false,
      detailFormatter: () => resolution
        ? selectedRow?.item.title ?? tLoose('common.none')
        : tLoose('common.unavailable'),
    }}
    items={rows.map((row) => row.item)}
    onSelect={(id) => {
      setOpen(false);
      const row = rows.find((candidate) => candidate.item.id === id);
      if (!row
        || row.item.disabled
        || selectionId(row.selection) === selectedId
        || props.isCurrent?.() === false
        || settingsVersion === null) return;
      const operation = mutationOperationRef.current + 1;
      mutationOperationRef.current = operation;
      setMutationOutcomeUnknown(false);
      const mutation = mutateAccountVoiceCredentialSource({
        mutation: {
          contribution: props.contribution,
          credentialSlotId: props.credentials.slot.id,
          selection: row.selection,
          expectedSettingsVersion: settingsVersion,
        },
        expectedDeclaration: props.declaration,
        resolveCurrentDeclaration: (contribution) => {
          if (props.isCurrent?.() === false) return null;
          const providerId = buildQualifiedPluginContributionKey(contribution);
          const current = voiceProviderRegistry.get(providerId);
          return current?.kind === 'voice.conversation-provider.v1'
            || current?.kind === 'voice.speech-engine.v1'
            ? current.declaration ?? null
            : null;
        },
        mutateAccountSettingsOnce: sync.mutateAccountSettingsOnce,
      });
      fireAndForget(mutation.then((result) => {
        if (
          result.status === 'outcomeUnknown'
          && mountedRef.current
          && mutationOperationRef.current === operation
          && props.isCurrent?.() !== false
        ) {
          // The source owner already performed its sole safe readback. Keep
          // that snapshot visible but never claim the chosen source applied.
          setMutationOutcomeUnknown(true);
        }
        return result;
      }), { tag: `VoiceCredentialSourceField.${props.contribution.pluginId}.${props.contribution.localId}` });
    }}
  />;
}
