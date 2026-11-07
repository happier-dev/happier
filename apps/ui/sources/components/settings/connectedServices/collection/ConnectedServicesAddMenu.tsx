import * as React from 'react';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { CollectionAddMenu } from '@/components/ui/lists/collection/CollectionAddMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { t } from '@/text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { presentConnectSheet } from '../setup/ConnectedServiceSetupModal';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { useVoiceProviderRegistryRevision } from '@/voice/registry/useVoiceProviderRegistryRevision';
import { useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

import {
  ConnectedServiceMark,
  formatAgentNames,
} from '../ConnectedServiceMark';
import type { ConnectedServicesIndexModel } from '../model/buildConnectedServicesIndexModel';
import type { useConnectedServicesIndex } from '../model/useConnectedServicesIndex';
import { buildConnectedServiceSetupCatalog, connectedServiceSetupCategoryTitle } from '../setup/buildConnectedServiceSetupCatalog';
import {
  buildConnectedServicesAddChoices,
  presentConnectedServicesAddMenuNotice,
  type ConnectedServicesAddChoice,
} from './connectedServicesAddChoices';

type AddCategory = ConnectedServicesAddChoice['category'];

/** The menu's groups, in the lab's order (`s2svc:menu`). */
const CATEGORY_ORDER: readonly AddCategory[] = [
  'secrets',
  'agent-sign-in',
  'voice',
  'pools',
  'gateways',
  'code-tools',
  'cloud-machines',
  'plugins',
];

function categoryTitle(category: AddCategory): string {
  switch (category) {
    case 'secrets':
      return t('settings.secrets');
    case 'voice':
      return t('connectedServicesCollection.menuVoice');
    case 'pools':
      return t('connectedServicesCollection.poolsGroup');
    case 'gateways':
      return t('settingsProvidersCollection.gateway.railGroup');
    case 'agent-sign-in':
    case 'code-tools':
    case 'cloud-machines':
    case 'plugins':
    case 'unknown':
      return connectedServiceSetupCategoryTitle(category);
  }
}

const styles = StyleSheet.create((theme) => ({
  count: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));

/** "N added" at a menu entry's end: what is already there before adding another. */
export const AddChoiceCount = React.memo(function AddChoiceCount(
  props: Readonly<{ count: number }>,
) {
  return (
    <Text style={styles.count}>
      {t('connectedServicesCollection.menuAdded', { count: props.count })}
    </Text>
  );
});

type ConnectedServicesRegistryReadFailure = NonNullable<ReturnType<typeof useConnectedServicesIndex>['registryReadFailure']>;

type IndexGatewayFacts = Pick<
  ReturnType<typeof useConnectedServicesIndex>,
  'gatewayContributionChoice' | 'addGateway' | 'gateways' | 'gatewayCountsByContributionKey'
>;

/**
 * Connected services' "+" (P8-R3, lab `s2svc:menu`): everything that can be added, grouped (Agent sign-in, Pools,
 * Gateways, Code and tools, Cloud machines, From plugins) and searchable. Choosing an entry opens its draft in the
 * Connect sheet for an account or the collection for a pool or gateway draft; it never creates
 * or probes anything. The entries come from the one add-choice projection (`buildConnectedServicesAddChoices`).
 */
export const ConnectedServicesAddMenu = React.memo(
  function ConnectedServicesAddMenu(
    props: Readonly<{
      model: ConnectedServicesIndexModel;
      gatewayFacts: IndexGatewayFacts;
      onOpen: (href: NonNullable<ConnectedServicesAddChoice['href']>) => void;
      onConnected?: (account: QualifiedConnectedAccountRef) => void;
      renderTrigger?: (toggle: () => void) => React.ReactNode;
      /**
       * One section's own "+" (Agent accounts, Code and tools, or Gateways when several contributions qualify):
       * the same menu, those groups only.
       */
      only?: AddCategory | readonly AddCategory[];
      /** The trigger's accessible name when it is a section's "+". */
      label?: string;
      /**
       * The index's failed read of what machines can add (`useConnectedServicesIndex`): the notice says why choices
       * are missing and retries that read in place, while saved accounts stay choosable.
       */
      registryReadFailure?: ConnectedServicesRegistryReadFailure | null;
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const scope = useActiveServerAccountScope();
    const voiceRevision = useVoiceProviderRegistryRevision(voiceProviderRegistry);
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const { model, gatewayFacts, onOpen } = props;
    const choices = React.useMemo(() => {
      const declarations = readAccountProviderDeclarations({ kind: 'account' });
      const gatewayCounts = gatewayFacts.gatewayCountsByContributionKey;
      const several =
        gatewayFacts.gatewayContributionChoice.status === 'choice_required';
      const all = buildConnectedServicesAddChoices({
        model,
        includeSecret: props.only === undefined,
        voiceProviders: voiceProviderRegistry.list().flatMap(entry => 'declaration' in entry && entry.declaration
          ? [{ pluginId: entry.pluginId, declaration: entry.declaration }] : []),
        localize: (text, pluginId) => localizePluginText(pluginId, text),
        gateways: gatewayFacts.gatewayContributionChoice,
        gatewayAdmission: {
          canAdd: gatewayFacts.addGateway !== null,
          reason: null,
          addedCountByContributionKey: gatewayCounts ?? undefined,
        },
        gatewayPresentation: (key) => {
          const name =
            declarations.find(
              (declaration) => declaration.contributionKey === key,
            )?.definition.name ?? null;
          return {
            title:
              several && name
                ? name
                : t('connectedServicesCollection.menuGatewayTitle'),
            purpose: t('connectedServicesCollection.menuGatewayPurpose'),
          };
        },
      });
      const only = props.only === undefined ? null : typeof props.only === 'string' ? [props.only] : props.only;
      return [...all].filter((choice) => !only || only.includes(choice.category)).sort(
        (left, right) =>
          CATEGORY_ORDER.indexOf(left.category) -
          CATEGORY_ORDER.indexOf(right.category),
      );
    }, [
      gatewayFacts.addGateway,
      gatewayFacts.gatewayContributionChoice,
      gatewayFacts.gatewayCountsByContributionKey,
      gatewayFacts.gateways,
      model,
      props.only,
      voiceRevision,
      localizePluginText,
    ]);
    const marks = React.useMemo(
      () =>
        new Map(
          buildConnectedServiceSetupCatalog(model).map(
            (entry) => [entry.serviceKey, entry] as const,
          ),
        ),
      [model],
    );
    const items = React.useMemo(
      (): ReadonlyArray<DropdownMenuItem> =>
        choices.map((choice): DropdownMenuItem => {
          const entry = choice.serviceKey
            ? marks.get(choice.serviceKey)
            : undefined;
          const icon =
            choice.kind === 'pool' ? (
              <Icon
                name="stack"
                size={16}
                color={theme.colors.text.secondary}
              />
            ) : choice.kind === 'gateway' ? (
              <Icon name="path" size={16} color={theme.colors.text.secondary} />
            ) : choice.kind === 'key' ? (
              <Icon name="key" size={16} color={theme.colors.text.secondary} />
            ) : (
              <ConnectedServiceMark
                legacyServiceId={entry?.legacyServiceId ?? null}
                pluginId={choice.kind === 'account' ? choice.service.pluginId : null}
                size="inline"
              />
            );
          const title =
            choice.kind === 'pool'
              ? t('connectedServicesCollection.menuPoolTitle', {
                  service: choice.title,
                })
              : choice.title;
          // A disabled entry says its own reason; one only waiting for a machine keeps saying what it is for
          // (the menu's notice says once why it can't be added).
          const purpose = choice.disabled && choice.reason
            ? choice.reason
            : choice.kind === 'account' && entry && entry.usedBy.length > 0
              ? formatAgentNames(entry.usedBy)
              : (choice.purpose ?? undefined);
          return {
            id: choice.key,
            testID: `connected-services-add:${choice.key}`,
            title,
            subtitle: purpose,
            icon,
            category: categoryTitle(choice.category),
            disabled: choice.disabled,
            rightElement: choice.addedCount ? (
              <AddChoiceCount count={choice.addedCount} />
            ) : undefined,
          };
        }),
      [choices, marks, theme.colors.text.secondary],
    );
    return (
      <CollectionAddMenu
        testID={props.testID ?? 'connected-services-add-menu'}
        triggerTestID="connected-services-rail:connect"
        items={items}
        notice={props.registryReadFailure && props.only !== 'gateways'
          // The page's line says why; the menu says plainly that its list is incomplete, with the same Retry.
          ? { text: t('connectedServicesSettings.addMenuIncomplete'), action: { label: t('common.retry'), onPress: props.registryReadFailure.retry } }
          : presentConnectedServicesAddMenuNotice(choices)}
        label={props.label ?? t('connectedServicesCollection.connectService')}
        searchPlaceholder={t('connectedServicesCollection.menuSearch')}
        onSelect={(id, selection) => {
          const choice = choices.find((candidate) => candidate.key === id);
          if (choice?.kind === 'account') {
            fireAndForget(presentConnectSheet({ scope, service: choice.service, ...(selection?.anchor ? { anchor: selection.anchor } : {}) }).then((result) => {
              if (result.kind !== 'dismissed') props.onConnected?.(result.account);
            }), { tag: 'ConnectedServicesAddMenu.connect' });
          } else if (choice?.kind === 'key') {
            fireAndForget(presentConnectSheet({ scope, service: choice.service, bindingTarget: choice.bindingTarget,
              ...(selection?.anchor ? { anchor: selection.anchor } : {}) }), { tag: 'ConnectedServicesAddMenu.key' });
          } else if (choice?.href) onOpen(choice.href);
        }}
        renderTrigger={props.renderTrigger}
      />
    );
  },
);
