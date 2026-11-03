import type { AuthContextType } from '@/auth/context/AuthContext';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';

/** The real host auth projection for local UI operations before Account sign-in. */
export function installSignedOutAuthForTest(): () => void {
  const previous = getCurrentAuth();
  const unused = async (): Promise<never> => { throw new Error('Unexpected authentication operation in a signed-out UI fixture'); };
  setCurrentAuth({ isAuthenticated: false, credentialAuthorityKind: 'none', credentials: null,
    login: unused, loginWithCredentials: unused, logout: unused, refreshFromActiveServer: unused } satisfies AuthContextType);
  return () => setCurrentAuth(previous);
}
