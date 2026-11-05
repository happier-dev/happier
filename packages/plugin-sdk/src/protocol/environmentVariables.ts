import { EnvVarRequirementV1ProtocolSchema } from '@happier-dev/protocol/profiles/environmentVariables';

import type { PluginActionResultById } from '../actions/actionTypeMap.generated.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

export type EnvVarRequirement = NonNullable<Extract<NonNullable<PluginActionResultById['projects.inspect']['definition']['document']>, { status: 'valid' }>['manifest']['environmentVariables']>[number];
export type EnvVarRequirementInput = Pick<EnvVarRequirement, 'name'> & Partial<Pick<EnvVarRequirement, 'kind' | 'required'>>;

/** Requirements retain the Project owner's name grammar and secret/required defaults. */
export const ProtocolEnvVarRequirementV1Schema: ProtocolComposableSchema<EnvVarRequirementInput, EnvVarRequirement> = EnvVarRequirementV1ProtocolSchema;
