import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { isDefaultAccountServiceUrl } from '@/components/settings/account/AccountServiceMark';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { HeaderLogo } from '@/components/ui/navigation/HeaderLogo';

const ROW_GLYPH_PX = 20;
const PAGE_GLYPH_PX = 24;

/**
 * A Home's plain mark: the Happier mark for Happier Cloud, a house for any other Home, a stack for a
 * group of Homes. Nothing sits behind it — no tile, fill or border (user ruling 2026-09-30) — and it
 * keeps the row or page mark's height, so a row does not change size with the kind of Home it names.
 */
export const HomeMark = React.memo(function HomeMark(props: Readonly<{
    /** The Home's address; the Happier Cloud Home is recognised by it. */
    serverUrl?: string | null;
    glyph?: 'house' | 'stack';
    /** `list`: the bare glyph for a collection row's mark column; `row` / `page` keep the entity mark's height. */
    size?: 'list' | 'row' | 'page';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const page = props.size === 'page';
    const size = page ? PAGE_GLYPH_PX : ROW_GLYPH_PX;
    const cloud = props.glyph !== 'stack' && typeof props.serverUrl === 'string' && isDefaultAccountServiceUrl(props.serverUrl);
    const glyph = cloud
        ? <HeaderLogo size={size} />
        : <Icon name={props.glyph ?? 'house'} size={size} color={theme.colors.text.secondary} />;
    if (props.size === 'list') return glyph;
    return (
        <PageHeaderMarkSlot testID={props.testID} size={page ? 'page' : 'row'}>
            {glyph}
        </PageHeaderMarkSlot>
    );
});
