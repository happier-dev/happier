import * as React from 'react';
import type { RegistryAppMappingV1 } from '@happier-dev/protocol/registries';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

/** Corrections stay local until the person explicitly re-runs the selected source's adapter. */
export function DeploymentTemplateMappingCorrection(props: Readonly<{
    source: RegistryAppMappingV1;
    onReview: (correction: RegistryAppMappingV1) => void;
    testID: string;
}>) {
    const [draft, setDraft] = React.useState(props.source);
    return <ItemGroup>
        <Item title={t('capabilities.store.appPage.choices.source')} accessoryLayout="stacked" showChevron={false}
            rightElement={<FieldTextInput testID={`${props.testID}.document`} multiline autoCapitalize="none" autoCorrect={false}
                accessibilityLabel={t('capabilities.store.appPage.choices.source')} value={draft.document}
                onChangeText={document => setDraft(previous => ({ ...previous, document }))} />} />
        {draft.template !== undefined ? <Item title={t('capabilities.store.appPage.choices.sourceMapping')}
            accessoryLayout="stacked" showChevron={false} rightElement={<FieldTextInput testID={`${props.testID}.template`} multiline
                autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('capabilities.store.appPage.choices.sourceMapping')}
                value={draft.template} onChangeText={template => setDraft(previous => ({ ...previous, template }))} />} /> : null}
        <Item title={t('capabilities.store.appPage.choices.checkMapping')} showChevron={false}
            rightElement={<RoundButton testID={`${props.testID}.review`} size="small" display="secondary"
                title={t('capabilities.store.appPage.choices.checkMapping')} disabled={!draft.document.trim()}
                onPress={() => props.onReview(draft)} />} />
    </ItemGroup>;
}
