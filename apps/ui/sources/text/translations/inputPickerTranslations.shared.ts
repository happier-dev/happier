

export type InputPickerTranslation = Readonly<{
    /** The control beneath the field. */
    browse: string;
    /** Its accessible name, naming the field it chooses for. */
    browseField: (params: Readonly<{ field: string }>) => string;
    /** The plugin that provides this choice was removed or turned off. */
    unavailable: string;
    /** The plugin was updated while its picker was open. */
    retired: string;
    /** The picker answered with something this field cannot hold. */
    invalid: string;
    /** The picker could not open or failed. */
    failed: string;
}>;


export const inputPickerTranslationsEnglish = { en: {
        browse: 'Browse…',
        browseField: ({ field }) => `Browse for ${field}`,
        unavailable: 'The plugin that provides this choice isn’t available. Your current value is kept.',
        retired: 'The plugin was updated while you were choosing. Try again.',
        invalid: 'That choice can’t be used here. Your current value is kept.',
        failed: 'The picker couldn’t open. Try again.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "en">;