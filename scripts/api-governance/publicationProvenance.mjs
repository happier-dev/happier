import semver from 'semver';

export function isExactCanonicalPublishedVersion(value) {
  return typeof value === 'string' && semver.valid(value) === value;
}

function fail(createError, diagnostic) {
  throw createError(diagnostic);
}

/**
 * Applies the publisher-owned first-publication facts to one already-validated
 * inventory. The profile owns its inventory shape; this owner supplies the
 * common provenance rule so package generators cannot diverge.
 */
export function projectPublishedInventoryProvenance({
  inventory,
  publishedVersion,
  previousPublishedInventory,
  validateInventory,
  symbols,
  symbolKey,
  createError,
}) {
  if (!isExactCanonicalPublishedVersion(publishedVersion)) {
    fail(createError, 'publishedVersion must be exact canonical semver');
  }

  const currentInventory = validateInventory(inventory);
  for (const symbol of symbols(currentInventory)) {
    if (Object.hasOwn(symbol, 'since')) {
      fail(createError, `current source inventory symbol ${symbolKey(symbol)} must not declare publisher-owned @since`);
    }
  }

  const previousSinceBySymbol = new Map();
  if (previousPublishedInventory !== undefined) {
    const priorInventory = validateInventory(previousPublishedInventory);
    for (const symbol of symbols(priorInventory)) {
      if (symbol.since === undefined) {
        fail(createError, `previous published inventory symbol ${symbolKey(symbol)} is missing @since`);
      }
      if (!isExactCanonicalPublishedVersion(symbol.since)) {
        fail(createError, `previous published inventory symbol ${symbolKey(symbol)} has invalid @since ${symbol.since}`);
      }
      if (!semver.lte(symbol.since, publishedVersion)) {
        fail(
          createError,
          `previous published inventory symbol ${symbolKey(symbol)} has @since ${symbol.since} after publishedVersion ${publishedVersion}`,
        );
      }
      previousSinceBySymbol.set(symbolKey(symbol), symbol.since);
    }
  }

  return validateInventory({
    ...currentInventory,
    symbols: symbols(currentInventory).map((symbol) => ({
      ...symbol,
      since: previousSinceBySymbol.get(symbolKey(symbol)) ?? publishedVersion,
    })),
  });
}
