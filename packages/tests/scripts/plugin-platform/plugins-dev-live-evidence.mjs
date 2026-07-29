function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parsePluginsDevChangeLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.kind !== 'plugins_dev_change') return null;
  if (typeof value.ok !== 'boolean') {
    throw new Error('plugins_dev_change envelope must carry a boolean ok result');
  }
  if (value.ok && !isRecord(value.data)) {
    throw new Error('Successful plugins_dev_change envelope is missing data');
  }
  if (!value.ok && !isRecord(value.error)) {
    throw new Error('Failed plugins_dev_change envelope is missing error');
  }
  return value;
}
