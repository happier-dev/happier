import { VoiceSurfaceView } from './VoiceSurfaceView';
import { useVoiceSurfaceModel } from './useVoiceSurfaceModel';
import type { VoiceSurfaceProps } from './voiceSurfaceTypes';

export function VoiceSurface(props: VoiceSurfaceProps) {
    const model = useVoiceSurfaceModel(props);

    if (model == null) {
        return null;
    }

    return <VoiceSurfaceView model={model} />;
}
