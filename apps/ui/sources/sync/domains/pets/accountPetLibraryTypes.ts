/** Initial hydration and settled read outcomes are distinct from library contents. */
export type AccountPetLibraryStatus = 'pending' | 'ready' | 'unavailable';

export {
    AccountPetAssetRefV1Schema as AccountPetAssetRefSchema,
    AccountPetLibraryEntryV1Schema as AccountPetMetadataSchema,
    AccountPetListResponseV1Schema as AccountPetsListResponseSchema,
    type AccountPetAssetRefV1 as AccountPetAssetRef,
    type AccountPetLibraryEntryV1 as AccountPetMetadata,
    type AccountPetListResponseV1 as AccountPetsListResponse,
} from "@happier-dev/protocol/pets/accountLibrary";
