import * as Application from 'expo-application';
import { Platform } from 'react-native';

function normalizeAndroidCertSha1(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase().replace(/\s+/g, '');
}

export function buildGoogleApiKeyRestrictionHeaders(opts?: {
  androidCertSha1?: string | null;
}): Record<string, string> {
  const applicationId = typeof Application.applicationId === 'string' ? Application.applicationId.trim() : '';
  if (!applicationId) return {};

  if (Platform.OS === 'ios') {
    return { 'X-Ios-Bundle-Identifier': applicationId };
  }

  if (Platform.OS === 'android') {
    const headers: Record<string, string> = { 'X-Android-Package': applicationId };
    const cert = normalizeAndroidCertSha1(opts?.androidCertSha1);
    if (cert) headers['X-Android-Cert'] = cert;
    return headers;
  }

  return {};
}

