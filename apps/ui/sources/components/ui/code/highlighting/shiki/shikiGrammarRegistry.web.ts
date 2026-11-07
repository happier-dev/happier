import { SHIKI_LANGUAGE_INFO } from './generatedShikiGrammarAssets';
import { bundledShikiLanguageLoaders } from './loadShikiLanguages.web';

const bundledLanguagesInfo = SHIKI_LANGUAGE_INFO.map(metadata => ({
    ...metadata,
    import: bundledShikiLanguageLoaders[metadata.id],
}));
const bundledLanguagesBase = Object.fromEntries(bundledLanguagesInfo.map(info => [info.id, info.import]));
const bundledLanguagesAlias = Object.fromEntries(
    bundledLanguagesInfo.flatMap(info => info.aliases?.map(alias => [alias, info.import]) ?? []),
);
const bundledLanguages = { ...bundledLanguagesBase, ...bundledLanguagesAlias };

// Installed Shiki's public langs/root/bundle-full entries consume these four
// registry exports. Their exact names and complete metadata are checked against
// the installed module; upstream highlighter and singleton code stay untouched.
export { bundledLanguagesInfo as i, bundledLanguagesAlias as n, bundledLanguagesBase as r, bundledLanguages as t };
