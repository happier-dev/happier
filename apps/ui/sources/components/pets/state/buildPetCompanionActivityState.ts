import { buildPetCompanionActivityModel } from '@/components/pets/activity';
import type {
    BuildPetCompanionActivityModelInput,
    PetCompanionActivityModel,
    PetCompanionActivityReason as CanonicalPetCompanionActivityReason,
    PetCompanionSessionSignals as CanonicalPetCompanionSessionSignals,
} from '@/components/pets/activity';

export type PetCompanionActivityReason = CanonicalPetCompanionActivityReason;
export type PetCompanionActivityState = PetCompanionActivityModel;
export type PetCompanionSessionSignals = CanonicalPetCompanionSessionSignals;
export type BuildPetCompanionActivityStateInput = BuildPetCompanionActivityModelInput;

export function buildPetCompanionActivityState(
    input: BuildPetCompanionActivityStateInput,
): PetCompanionActivityState {
    return buildPetCompanionActivityModel(input);
}
