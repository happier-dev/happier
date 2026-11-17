import * as React from 'react';
import { Icon, IconButton, Row, usePluginTranslation } from '@happier-dev/plugin-ui';

/** The same explicit catalogue page intents in the rail and Overview directory. */
export function CataloguePagination(props: Readonly<{
    kind: 'tables' | 'schemas';
    previousPage?: () => void;
    nextPage?: () => void;
}>) {
    const translate = usePluginTranslation();
    if (!props.previousPage && !props.nextPage) return null;
    return <Row gap="xsmall">
        <IconButton
            accessibilityLabel={props.kind === 'tables'
                ? translate('plugins.database.catalogue.previousTables', 'Previous tables')
                : translate('plugins.database.catalogue.previousSchemas', 'Previous schemas')}
            icon={<Icon name="back" />} disabled={!props.previousPage} onPress={props.previousPage}
        />
        <IconButton
            accessibilityLabel={props.kind === 'tables'
                ? translate('plugins.database.catalogue.nextTables', 'Next tables')
                : translate('plugins.database.catalogue.nextSchemas', 'Next schemas')}
            icon={<Icon name="forward" />} disabled={!props.nextPage} onPress={props.nextPage}
        />
    </Row>;
}
