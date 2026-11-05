import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

/**
 * The detail pane beside a collection rail before it can land on an entry: the collection is still
 * loading, could not be read, or has nothing to select. One centred state owns the whole pane, so
 * every settings collection (Agents, Profiles, Roles, Providers) draws this moment the same way.
 */
export const CollectionLandingState = React.memo(function CollectionLandingState(
    props: Omit<React.ComponentProps<typeof SurfaceStateCard>, 'replacesContent' | 'size' | 'layout'>,
) {
    return (
        <ItemList containerStyle={styles.pane}>
            <SurfaceStateCard {...props} replacesContent />
        </ItemList>
    );
});

const styles = StyleSheet.create({
    pane: {
        flexGrow: 1,
        justifyContent: 'center',
    },
});
