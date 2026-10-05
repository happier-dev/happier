export type { TranslationStructure } from './translations/en';

export type Translations = import('./translations/en').TranslationStructure;

type WidenTranslationValues<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends string
        ? string
        : T extends object
            ? { [Key in keyof T]: WidenTranslationValues<T[Key]> }
            : T;

export function defineTranslations<const T extends object>(value: T): WidenTranslationValues<T> {
    // This declaration carrier widens string values without changing keys, modifiers, functions, or runtime identity.
    return value as WidenTranslationValues<T>;
}
