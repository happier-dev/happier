export type MetroPackagerStatusResponseInspection = Readonly<{
  outcome: 'ready' | 'http-error' | 'invalid-body';
  detail: string;
}>;

export async function inspectMetroPackagerStatusResponse(
  response: Response,
): Promise<MetroPackagerStatusResponseInspection> {
  if (!response.ok) {
    return {
      outcome: 'http-error',
      detail: `HTTP ${response.status}`,
    };
  }

  const body = await response.text().catch(() => '');
  if (body.length > 0) {
    const ready = body.includes('packager-status:running');
    return {
      outcome: ready ? 'ready' : 'invalid-body',
      detail: ready ? '' : 'status body did not report packager-status:running',
    };
  }

  const projectRootHeader = response.headers.get('x-react-native-project-root');
  const identifiedByHeader =
    typeof projectRootHeader === 'string' && projectRootHeader.trim().length > 0;
  return {
    outcome: identifiedByHeader ? 'ready' : 'invalid-body',
    detail: identifiedByHeader
      ? ''
      : 'empty status body without a Metro-identifying header',
  };
}
