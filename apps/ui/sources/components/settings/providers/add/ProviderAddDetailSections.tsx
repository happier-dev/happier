import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { formatAgentNameListFolded } from '@/components/capabilities/identity/agentNameList';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ProviderDeclarationDetail } from '@/providers/catalog/providerDeclarationDetail';
import { presentProviderDeclarationModels } from '@/providers/catalog/providerDeclarationModelPresentation';
import { knownEndpointProtocolLabel } from '@/providers/connection/endpointProtocolLabel';
import { t } from '@/text';

/**
 * A catalog Provider's details under its identity and Connect (lab `m:provider`): what it needs, which agents it
 * works with, its models and where it comes from. Only declared facts are drawn; an absent fact is not guessed.
 */
export function ProviderAddDetailSections(
  props: Readonly<{
    name: string;
    kind: 'frontier' | 'aggregator' | 'cloud' | 'local';
    detail: ProviderDeclarationDetail;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const glyph = (name: IconName) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  const { auth, connectedAccounts, worksWith, models, source } = props.detail;
  const keyHost = auth?.keyUrl ? hostOf(auth.keyUrl) : null;
  const modelPresentation = presentProviderDeclarationModels(props.name, models);

  return (
    <View>
      <ItemGroup
        title={t('settingsProvidersCollection.addDetail.needsTitle')}
        testID={`${props.testID}:needs`}
      >
        {auth ? (
          <Item
            title={t(
              auth.required
                ? 'settingsProvidersCollection.addDetail.needsApiKey'
                : 'settingsProvidersCollection.addDetail.needsApiKeyOptional',
            )}
            subtitle={
              keyHost
                ? t('settingsProvidersCollection.addDetail.needsKeyFrom', {
                    host: keyHost,
                  })
                : t('settingsProvidersCollection.addDetail.needsKeySaved')
            }
            icon={glyph('key')}
            showChevron={false}
          />
        ) : null}
        {connectedAccounts && connectedAccounts.length > 0 ? (
          <Item
            title={t('settingsProvidersCollection.addDetail.needsAccount')}
            subtitle={t(
              'settingsProvidersCollection.addDetail.needsAccountBody',
            )}
            icon={glyph('user-circle')}
            showChevron={false}
          />
        ) : null}
        {props.kind === 'local' ? (
          <Item
            title={t('settingsProvidersCollection.addDetail.needsLocal')}
            icon={glyph('desktop')}
            showChevron={false}
          />
        ) : null}
        {!auth &&
        !(connectedAccounts && connectedAccounts.length > 0) &&
        props.kind !== 'local' ? (
          <Item
            title={t('settingsProvidersCollection.addDetail.needsNothing')}
            icon={glyph('check-circle')}
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      <ItemGroup
        title={t('settingsProvidersCollection.addDetail.worksWithTitle')}
        testID={`${props.testID}:works-with`}
      >
        {worksWith.length > 0 ? (
          fitLines(worksWith).map((line) => (
            <Item
              key={line.key}
              title={formatAgentNameListFolded(line.names, 2)}
              subtitle={
                [
                  knownEndpointProtocolLabel(line.protocol),
                  line.experimental
                    ? t('settingsProviders.compatibility.experimental')
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || undefined
              }
              icon={glyph('robot')}
              showChevron={false}
            />
          ))
        ) : (
          <Item
            title={t('settingsProvidersCollection.addDetail.worksWithUnknown')}
            icon={glyph('robot')}
            showChevron={false}
          />
        )}
      </ItemGroup>

      <ItemGroup
        title={t('settingsProvidersCollection.addDetail.modelsTitle')}
        testID={`${props.testID}:models`}
      >
          <Item
            title={modelPresentation.title}
            subtitle={modelPresentation.subtitle}
            icon={glyph('list-bullets')}
            showChevron={false}
          />
      </ItemGroup>

      <ItemGroup
        title={t('settingsProvidersCollection.addDetail.sourceTitle')}
        testID={`${props.testID}:source`}
      >
        <Item
          title={t(
            source.provenance === 'first_party'
              ? 'settingsProvidersCollection.addDetail.sourceBuiltIn'
              : 'settingsProvidersCollection.addDetail.sourcePlugin',
          )}
          subtitle={[
            t(
              source.provenance === 'first_party'
                ? 'settingsProvidersCollection.addDetail.sourceBuiltInBody'
                : 'settingsProvidersCollection.addDetail.sourcePluginBody',
            ),
            source.websiteUrl ? hostOf(source.websiteUrl) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          icon={glyph(
            source.provenance === 'first_party'
              ? 'shield-check'
              : 'puzzle-piece',
          )}
          showChevron={false}
        />
      </ItemGroup>
    </View>
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** One line per way in (protocol and its standing), naming the agents that use it, so many agents stay one short sheet. */
function fitLines(worksWith: ProviderDeclarationDetail['worksWith']) {
  type FitLine = { key: string; protocol: string; experimental: boolean; names: string[] };
  const lines = new Map<string, FitLine>();
  for (const fit of worksWith) {
    const experimental = fit.compatibility.status === 'experimental';
    const key = `${fit.compatibility.selectedProtocol}:${experimental ? 'experimental' : 'verified'}`;
    const line: FitLine = lines.get(key) ?? { key, protocol: fit.compatibility.selectedProtocol, experimental, names: [] };
    line.names.push(fit.name ?? t('settingsProvidersCollection.addDetail.worksWithAgent'));
    lines.set(key, line);
  }
  return [...lines.values()];
}
