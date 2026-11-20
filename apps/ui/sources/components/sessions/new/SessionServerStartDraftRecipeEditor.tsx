import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { isPermissionMode } from '@/sync/domains/permissions/permissionTypes';
import type { SessionServerStartDraftSeed, SessionServerStartDraftTarget } from './serverStartDraftComposer';
import { useSessionServerStartDraftRecipe } from './useSessionServerStartDraftRecipe';
import { SessionServerStartDraftComposerBody } from './SessionServerStartDraftComposerBody';

type RecipeEditorProps = Readonly<{
    seed: SessionServerStartDraftSeed;
    target: SessionServerStartDraftTarget;
    requireWorkspaceWriteDenial?: boolean;
    onResolve: (draft: SessionServerStartSpawnDraftV1 | null) => void;
}>;

/**
 * A value editor: the default and Change share the selector's recipe model; neither admits work.
 * The recipe model belongs to one Machine, so choosing another Machine in the Where chip starts the
 * recipe again there, keeping its permissions and the chosen folder.
 */
export function SessionServerStartDraftRecipeEditor(props: RecipeEditorProps) {
    const [placed, setPlaced] = React.useState(() => ({ seed: props.seed, target: props.target }));
    return <RecipeEditor key={`${placed.target.serverId}:${placed.target.machineId}`} {...props}
        seed={placed.seed} target={placed.target} onMove={(target, seed) => setPlaced({ target, seed })} />;
}

function RecipeEditor(props: RecipeEditorProps & Readonly<{
    onMove: (target: SessionServerStartDraftTarget, seed: SessionServerStartDraftSeed) => void;
}>) {
    const model = useSessionServerStartDraftRecipe(props);
    const { onMove, target } = props;
    const permissionMode = model.selection.permissionMode;
    const move = React.useCallback((machineId: string, directory: string) => onMove({ ...target, machineId }, {
        ...(isPermissionMode(permissionMode) ? { permissionMode } : {}),
        ...(directory ? { directory } : {}),
    }), [onMove, permissionMode, target]);
    const resolved = React.useRef(false);
    const resolve = React.useCallback(() => {
        if (resolved.current) return;
        const draft = model.resolveDraft();
        if (!draft) return;
        resolved.current = true;
        props.onResolve(draft);
    }, [model, props.onResolve]);
    // Add and Change (lab dpRev `add`): the composer's own chips, framed under the list they add to.
    return <View testID="participant-recipe-editor" style={styles.frame}>
        <SessionServerStartDraftComposerBody seed={props.seed} model={model} presentation="chips" onMoveMachine={move} />
        <View style={styles.actions}>
            <RoundButton testID="participant-recipe-cancel" size="small" display="inverted" title={t('common.cancel')}
                onPress={() => props.onResolve(null)} />
            <RoundButton testID="participant-recipe-save" size="small" display="secondary" title={props.seed.existingDraft ? t('common.save') : t('common.add')}
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
