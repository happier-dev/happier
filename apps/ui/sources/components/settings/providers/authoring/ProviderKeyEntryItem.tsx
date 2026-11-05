import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { ProviderExternalLink } from '../ProviderExternalLinkItem';
import { ProviderSavedSecretControl } from '../ProviderPageParts';

/**
 * The API key of a provider being added, asked for where it is needed (PA1): one row, "Add key" opening
 * the Connect sheet at the button (a new key or a saved one), then the chosen key's name and Replace.
 * Before a key is chosen the provider's "Get API key" link sits beside Add key. One row for catalog and
 * custom providers.
 */
export function ProviderKeyEntryItem(
  props: Readonly<{
    /** What the key is for, said while the Account can save one. */
    description: string;
    keyUrl?: string | null;
    secretSelected: boolean;
    selectedSecretName?: string | null;
    savedSecretSelectionEnabled: boolean;
    /** Receives the press, so the sheet hangs from the button that opened it. */
    onPickSecret: (event?: unknown) => void;
  }>,
): React.ReactElement {
  const getKey = !props.secretSelected && props.savedSecretSelectionEnabled && props.keyUrl ? props.keyUrl : null;
  return (
    <Item
      testID="settings-provider-authoring-api-key"
      title={t('settingsProviders.authoring.apiKey')}
      subtitle={
        props.savedSecretSelectionEnabled
          ? props.description
          : t('settingsProviders.local.accountScopeMismatchDescription')
      }
      subtitleLines={0}
      showChevron={false}
      rightElement={
        <View style={styles.trailing}>
          {getKey ? <ProviderExternalLink kind="getApiKey" url={getKey} /> : null}
          <ProviderSavedSecretControl
            testID="settings-provider-authoring-api-key"
            saved={props.secretSelected}
            selectedName={props.selectedSecretName}
            disabled={!props.savedSecretSelectionEnabled}
            onChoose={props.onPickSecret}
          />
        </View>
      }
      rightElementOutsidePressable
    />
  );
}

const styles = StyleSheet.create((theme) => ({
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s16,
    },
}));
