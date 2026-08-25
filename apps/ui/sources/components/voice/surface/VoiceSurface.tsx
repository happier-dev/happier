import { VoiceSurfaceView } from './VoiceSurfaceView';
import { useVoiceSurfaceModel } from './useVoiceSurfaceModel';
import type { VoiceSurfaceProps } from './voiceSurfaceTypes';

export function VoiceSurface(props: VoiceSurfaceProps) {
    // Retained Session surfaces keep their editor/draft tree mounted. Voice's
    // presentation runtime is not part of that retained state: keeping it
    // mounted would retain subscriptions and recovery-focus effects for an
    // invisible surface.
    if (props.isPresented === false) {
        return null;
    }

    const model = useVoiceSurfaceModel(props);

    if (model == null) {
        return null;
    }

    return <VoiceSurfaceView model={model} />;
}
