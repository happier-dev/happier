import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import type { SessionServerStartDraftSeed, SessionServerStartDraftTarget } from './serverStartDraftComposer';
import { useSessionServerStartDraftRecipe, type SessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';
import { SessionServerStartDraftComposerBody } from './SessionServerStartDraftComposerBody';

/** A default that cannot settle on its own shows its fields, so the person sees what it needs. */
function defaultsCannotSettle(model: SessionServerStartDraftRecipe): boolean {
    const phase = model.daemonMergedProjection.phase;
    if (phase === 'idle' || phase === 'loading') return false;
    return phase !== 'ready' || !model.selectedPlacement.machineReady
        || (model.facts.agentTargets !== undefined && model.agentTargets.length === 0);
}

/** A value editor: the default and Change share the selector's recipe model; neither admits work. */
export function SessionServerStartDraftRecipeEditor(props: Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    automatic: boolean;
    onResolve: (draft: SessionServerStartSpawnDraftV1 | null) => void;
}>) {
    const model = useSessionServerStartDraftRecipe(props);
    const resolved = React.useRef(false);
    const resolve = React.useCallback(() => {
        if (resolved.current) return;
        const draft = model.resolveDraft();
        if (!draft) return;
        resolved.current = true;
        props.onResolve(draft);
    }, [model, props.onResolve]);
    React.useEffect(() => {
        if (props.automatic && model.canSubmit) resolve();
    }, [model.canSubmit, props.automatic, resolve]);
    // One tap chooses with defaults: while they settle, the chosen row itself says so (the composer's
    // row line), so nothing opens here unless the defaults cannot settle.
    if (props.automatic && !defaultsCannotSettle(model)) return <View testID="participant-recipe-editor" />;
    // Change (lab flows `recipe`): the recipe's own fields, framed under the row they belong to.
    return <View testID="participant-recipe-editor" style={styles.frame}>
        <SessionServerStartDraftComposerBody seed={props.seed} model={model} />
        <View style={styles.actions}>
            <RoundButton testID="participant-recipe-cancel" size="small" display="inverted" title={t('common.cancel')}
                onPress={() => props.onResolve(null)} />
            <RoundButton testID="participant-recipe-save" size="small" display="secondary" title={t('common.save')}
                disabled={!model.canSubmit} onPress={resolve} />
        </View>
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    // The shared body's grouped sheet is the recipe's one frame (lab `recipe`/`recipeP`); a border here
    // drew a second frame around it.
    frame: {
        marginTop: theme.space.s4,
        marginBottom: theme.space.s8,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s8,
    },
}));
