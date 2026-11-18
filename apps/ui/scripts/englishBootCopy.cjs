// Babel plugin for the Metro graph's translation modules (sources/text/translations/*.ts).
//
// Metro evaluates English copy only: web and native load every other locale from the locale
// producer's bundles (scripts/prepareLocaleAssets.mjs), which read the untransformed sources
// with esbuild. In a locale map — an object literal with a non-text `en` entry and entries for other
// locales — each other-locale entry becomes a getter here, so a module written with every locale
// inline evaluates only its English copy on the boot path (P03-BOOT-CUT). Getters, not removal:
// composing modules read `other.ca.word` at load, and a getter keeps every such read correct.
// A map whose `en` entry is plain text (language names, for example) is English copy and stays.
// Guarded by sources/text/i18n.webDelivery.test.ts.
const OTHER_LOCALES = new Set(['ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant',
  'zhHans', 'zhHant', 'zh_Hans', 'zh_Hant']);

function keyOf(property, t) {
  if (!t.isObjectProperty(property) || property.computed) return null;
  if (t.isIdentifier(property.key)) return property.key.name;
  if (t.isStringLiteral(property.key)) return property.key.value;
  return null;
}

function isText(node, t) {
  return t.isStringLiteral(node) || (t.isTemplateLiteral(node) && node.expressions.length === 0);
}

module.exports = function englishBootCopy({ types: t }) {
  return {
    name: 'happier-english-boot-copy',
    visitor: {
      ObjectExpression(path) {
        const properties = path.node.properties;
        const english = properties.find((property) => keyOf(property, t) === 'en');
        if (!english || isText(english.value, t)) return;
        path.node.properties = properties.map((property) => {
          const key = keyOf(property, t);
          if (!OTHER_LOCALES.has(key)) return property;
          const name = t.isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key);
          return t.objectMethod('get', name, [], t.blockStatement([t.returnStatement(property.value)]));
        });
      },
    },
  };
};

/** The translation modules Metro bundles at the English root (either path separator). */
module.exports.appliesTo = (filename) => /[\\/]sources[\\/]text[\\/]translations[\\/][^\\/]+\.ts$/.test(filename);
