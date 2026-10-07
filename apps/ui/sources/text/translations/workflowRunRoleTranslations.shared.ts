

export const en = {
    rolesTitle: 'Roles for this run', rolesYour: 'Your roles',
    rolesChanged: ({ count }: { count: number }) => `${count} changed for this run`,
    rolesUnchanged: 'Everything else stays the same.', useYourRole: 'Use your role',
    targetsTitle: 'Each step runs in', rolesPrefillFailed: 'Could not read the roles from your last run. Try again.',
};


export const workflowRunRoleTranslationsEnglish: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "en"> = { en };