export type TokenOnlyAuthCredentials = Readonly<{
    token: string;
}>;

/**
 * This device's own classification of the Account E2EE material it holds.
 * Absent means active: older stored shapes keep the downgrade pin. Only this
 * device writes `historical` (its own conversion, or the person's explicit
 * reclassification); a Home's reported mode never does.
 */
export type AccountE2eeMaterialCustody = Readonly<{ custody?: 'historical' }>;

export type LegacyAuthCredentials = Readonly<{
    token: string;
    secret: string;
}> & AccountE2eeMaterialCustody;

export type DataKeyAuthCredentials = Readonly<{
    token: string;
    encryption: Readonly<{
        publicKey: string;
        machineKey: string;
    }>;
}> & AccountE2eeMaterialCustody;

export type AuthCredentials =
    | TokenOnlyAuthCredentials
    | LegacyAuthCredentials
    | DataKeyAuthCredentials;
