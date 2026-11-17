export const PET_IMPORT_ACTION_ID_V1 = 'pet.import' as const;
export const PET_DELETE_ACTION_ID_V1 = 'pet.delete' as const;

export const PET_ACTION_IDS_V1 = [PET_IMPORT_ACTION_ID_V1, PET_DELETE_ACTION_ID_V1] as const;
export type PetActionIdV1 = (typeof PET_ACTION_IDS_V1)[number];
export function isPetActionIdV1(id: string): id is PetActionIdV1 {
  return (PET_ACTION_IDS_V1 as readonly string[]).includes(id);
}
