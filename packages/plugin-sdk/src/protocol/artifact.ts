import { ArtifactGetOutputV1ProtocolSchema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

/** The ordinary Artifact Action keeps audience, revision and content admission. */
export const ProtocolArtifactGetOutputV1Schema: ProtocolComposableSchema<PluginActionResultById['artifact.get']> = ArtifactGetOutputV1ProtocolSchema;
