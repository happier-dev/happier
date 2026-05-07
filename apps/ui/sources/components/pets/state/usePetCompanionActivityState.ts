import {
    usePetCompanionActivityModel,
    type PetCompanionActivityModel,
} from '@/components/pets/activity';

export type PetCompanionActivityState = PetCompanionActivityModel;

export function usePetCompanionActivityState(): PetCompanionActivityState {
    return usePetCompanionActivityModel();
}
