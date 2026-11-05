import * as React from 'react';
import { ProtocolSecretReferenceOverlayV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { Button, HappierInputField, Item, Row, usePluginTheme, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { LocalRunSelection } from '../../../actions/local/contracts.js';

type Binding = NonNullable<LocalRunSelection['environmentBindings']>['bindings'][string];

/** The host picker owns reference selection; Project launch still owns materialization. */
export function LocalActSecretReferenceField(props: Readonly<{
  name: string;
  binding: Binding | undefined;
  onChange(binding: Binding | undefined): void;
}>) {
  const theme = usePluginTheme();
  const t = usePluginTranslation();
  const value = props.binding && { ref: props.binding.ref, resourceRevision: props.binding.revision };
  return <Item title={props.name} fieldAccessory accessoryOutsidePressable accessory={
    <Row gap="small" wrap>
      <HappierInputField
        theme={theme}
        frame="none"
        field={{ path: props.name, title: props.name, widget: 'select', inputType: { hostType: 'savedSecretReference' } }}
        value={value}
        valueLabel={props.binding ? t('plugins.github.localRun.secret.selected', 'Saved Secret selected') : undefined}
        onChange={next => {
          if (!next || typeof next !== 'object' || !('ref' in next) || !('resourceRevision' in next)) return;
          // The shared picker and execution overlay name the same revision differently.
          const overlay = ProtocolSecretReferenceOverlayV1Schema.safeParse({ v: 1, bindings: {
            [props.name]: { ref: next.ref, revision: next.resourceRevision },
          } });
          if (overlay.success) props.onChange(overlay.data.bindings[props.name]);
        }}
      />
      {props.binding ? <Button variant="plain" title={t('plugins.github.localRun.secret.clear', 'Clear {name}', { name: props.name })}
        onPress={() => props.onChange(undefined)} /> : null}
    </Row>
  } />;
}
