import type { SupportedLanguage } from '../_all';

type IdentityAdministrationLanguage = Exclude<SupportedLanguage, 'zh-Hans' | 'zh-Hant'> | 'zhHans' | 'zhHant';

type Words = Readonly<{
    title: string;
    subtitle: string;
    homeConnections: string;
    add: string;
    empty: string;
    unreadable: string;
    active: string;
    disabled: string;
    needsTest: string;
    tested: string;
    staleTest: string;
    configuration: string;
    issuer: string;
    clientId: string;
    clientSecret: string;
    secretSet: string;
    secretNotSet: string;
    secretNeedsAttention: string;
    secretRepair: string;
    secretRetain: string;
    scopes: string;
    loginClaim: string;
    emailClaim: string;
    groupsClaim: string;
    fetchUserInfo: string;
    advanced: string;
    hideAdvanced: string;
    actions: string;
    test: string;
    testing: string;
    validate: string;
    validating: string;
    validated: string;
    edit: string;
    save: string;
    saving: string;
    enable: string;
    disable: string;
    remove: string;
    createTitle: string;
    editTitle: string;
    displayName: string;
    required: string;
    invalidIssuer: string;
    secretRequired: string;
    error: string;
    errorForbidden: string;
    errorConflict: string;
    errorMissing: string;
    errorInUse: string;
    errorProviderUnavailable: string;
    errorRateLimited: string;
    errorInvalid: string;
    errorImmutable: string;
    accounts: string;
    connections: string;
    directoryGroups: string;
    searchGroups: string;
    mapCreate: string;
    mapExisting: string;
    mappedTo: string;
    unmapped: string;
    chooseGroup: string;
    loadMore: string;
    removeMapping: string;
    errorAuthenticationRequired: string;
    errorPolicyUnavailable: string;
    errorPolicyInUse: string;
    errorNotAllowed: string;
    errorNeedsAttention: string;
    /** `Sync now` refused because the source is paused; its recovery is Resume. */
    errorSyncPaused: string;
    alternateLogins: string;
    recoveryAuthenticationPolicy: string;
    recoveryAlternateLogin: string;
    recoveryDirectory: string;
    recoveryGroupMappings: string;
    recoveryTeamAuthentication: string;
    callbackUrl: string;
    callbackUrlHint: string;
}>;

type GitHubAccessWords = Readonly<{
    githubCurrentAccess: string;
    githubCurrentAccessSubtitle: string;
    githubCurrentAccessEmpty: string;
    githubSetupAccess: string;
    githubSetupAccessSubtitle: string;
    githubRemoveInstallationFor: (params: { name: string }) => string;
}>;

const githubAccessWords: Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>> = {
    en: {
        githubCurrentAccess: 'Current access',
        githubCurrentAccessSubtitle: 'Required by the enabled connections and directory sources that use this installation.',
        githubCurrentAccessEmpty: 'No access is required by enabled consumers.',
        githubSetupAccess: 'Setup and repair access',
        githubSetupAccessSubtitle: 'Access for configured connections, including disabled connections and paused directory sources. Grant missing access on GitHub before enabling or resuming them, then verify the installation again.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Remove installation for ${name}`,
    },
    fr: {
        githubCurrentAccess: 'Accès actuel',
        githubCurrentAccessSubtitle: 'Requis par les connexions et les sources d’annuaire activées qui utilisent cette installation.',
        githubCurrentAccessEmpty: 'Aucun accès n’est requis par les services activés.',
        githubSetupAccess: 'Accès pour la configuration et la réparation',
        githubSetupAccessSubtitle: 'Accès pour les connexions configurées, y compris celles désactivées et les sources d’annuaire en pause. Accordez les accès manquants sur GitHub avant de les activer ou reprendre, puis vérifiez à nouveau l’installation.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Supprimer l’installation pour ${name}`,
    },
    es: {
        githubCurrentAccess: 'Acceso actual',
        githubCurrentAccessSubtitle: 'Necesario para las conexiones y las fuentes de directorio activadas que usan esta instalación.',
        githubCurrentAccessEmpty: 'Los servicios activados no requieren acceso.',
        githubSetupAccess: 'Acceso para configuración y reparación',
        githubSetupAccessSubtitle: 'Acceso para las conexiones configuradas, incluidas las desactivadas y las fuentes de directorio en pausa. Concede el acceso que falta en GitHub antes de activarlas o reanudarlas y vuelve a verificar la instalación.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Eliminar la instalación de ${name}`,
    },
    de: {
        githubCurrentAccess: 'Aktuell erforderlicher Zugriff',
        githubCurrentAccessSubtitle: 'Erforderlich für aktivierte Verbindungen und Verzeichnisquellen, die diese Installation verwenden.',
        githubCurrentAccessEmpty: 'Aktivierte Dienste benötigen keinen Zugriff.',
        githubSetupAccess: 'Zugriff für Einrichtung und Reparatur',
        githubSetupAccessSubtitle: 'Zugriff für konfigurierte Verbindungen, einschließlich deaktivierter Verbindungen und pausierter Verzeichnisquellen. Gewähre fehlenden Zugriff auf GitHub vor dem Aktivieren oder Fortsetzen und prüfe die Installation erneut.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Installation für ${name} entfernen`,
    },
    it: {
        githubCurrentAccess: 'Accesso attuale',
        githubCurrentAccessSubtitle: 'Richiesto dalle connessioni e dalle fonti di directory abilitate che usano questa installazione.',
        githubCurrentAccessEmpty: 'I servizi abilitati non richiedono accesso.',
        githubSetupAccess: 'Accesso per configurazione e riparazione',
        githubSetupAccessSubtitle: 'Accesso per le connessioni configurate, incluse quelle disabilitate e le fonti di directory in pausa. Concedi gli accessi mancanti su GitHub prima di abilitarle o riprenderle, poi verifica di nuovo l’installazione.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Rimuovi l’installazione per ${name}`,
    },
    pt: {
        githubCurrentAccess: 'Acesso atual',
        githubCurrentAccessSubtitle: 'Necessário para as ligações e fontes de diretório ativadas que usam esta instalação.',
        githubCurrentAccessEmpty: 'Os serviços ativados não requerem acesso.',
        githubSetupAccess: 'Acesso para configuração e reparação',
        githubSetupAccessSubtitle: 'Acesso para ligações configuradas, incluindo as desativadas e fontes de diretório em pausa. Concede o acesso em falta no GitHub antes de as ativar ou retomar e verifica novamente a instalação.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Remover a instalação de ${name}`,
    },
    ca: {
        githubCurrentAccess: 'Accés actual',
        githubCurrentAccessSubtitle: 'Necessari per a les connexions i les fonts de directori activades que fan servir aquesta instal·lació.',
        githubCurrentAccessEmpty: 'Els serveis activats no requereixen accés.',
        githubSetupAccess: 'Accés per a configuració i reparació',
        githubSetupAccessSubtitle: 'Accés per a les connexions configurades, incloses les desactivades i les fonts de directori en pausa. Concedeix l’accés que falta a GitHub abans d’activar-les o reprendre-les i torna a verificar la instal·lació.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Elimina la instal·lació de ${name}`,
    },
    pl: {
        githubCurrentAccess: 'Obecny dostęp',
        githubCurrentAccessSubtitle: 'Wymagany przez włączone połączenia i źródła katalogu korzystające z tej instalacji.',
        githubCurrentAccessEmpty: 'Włączone usługi nie wymagają dostępu.',
        githubSetupAccess: 'Dostęp do konfiguracji i naprawy',
        githubSetupAccessSubtitle: 'Dostęp dla skonfigurowanych połączeń, również wyłączonych i wstrzymanych źródeł katalogu. Przyznaj brakujący dostęp w GitHub przed ich włączeniem lub wznowieniem, a następnie ponownie zweryfikuj instalację.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Usuń instalację dla ${name}`,
    },
    ru: {
        githubCurrentAccess: 'Текущий доступ',
        githubCurrentAccessSubtitle: 'Требуется включённым подключениям и источникам каталога, использующим эту установку.',
        githubCurrentAccessEmpty: 'Включённым сервисам доступ не требуется.',
        githubSetupAccess: 'Доступ для настройки и восстановления',
        githubSetupAccessSubtitle: 'Доступ для настроенных подключений, включая отключённые и приостановленные источники каталога. Предоставьте недостающий доступ в GitHub перед включением или возобновлением, затем повторно проверьте установку.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Удалить установку для ${name}`,
    },
    ja: {
        githubCurrentAccess: '現在必要なアクセス',
        githubCurrentAccessSubtitle: 'このインストールを使用する有効な接続とディレクトリソースに必要です。',
        githubCurrentAccessEmpty: '有効なサービスに必要なアクセスはありません。',
        githubSetupAccess: '設定と修復のためのアクセス',
        githubSetupAccessSubtitle: '無効な接続や一時停止中のディレクトリソースを含む、設定済みの接続に必要なアクセスです。有効化または再開する前に GitHub で不足しているアクセスを許可し、インストールを再確認してください。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `${name} のインストールを削除`,
    },
    zhHans: {
        githubCurrentAccess: '当前访问权限',
        githubCurrentAccessSubtitle: '使用此安装的已启用连接和目录源所需的权限。',
        githubCurrentAccessEmpty: '已启用的服务不需要访问权限。',
        githubSetupAccess: '设置和修复所需的权限',
        githubSetupAccessSubtitle: '已配置连接所需的权限，包括已停用的连接和已暂停的目录源。在启用或恢复它们之前，请在 GitHub 授予缺少的权限，然后重新验证安装。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `移除 ${name} 的安装`,
    },
    zhHant: {
        githubCurrentAccess: '目前存取權限',
        githubCurrentAccessSubtitle: '使用此安裝的已啟用連線及目錄來源所需的權限。',
        githubCurrentAccessEmpty: '已啟用的服務不需要存取權限。',
        githubSetupAccess: '設定與修復所需的權限',
        githubSetupAccessSubtitle: '已設定連線所需的權限，包括已停用的連線與已暫停的目錄來源。啟用或繼續之前，請在 GitHub 授予缺少的權限，然後重新驗證安裝。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `移除 ${name} 的安裝`,
    },
};

type OidcEditorWords = Readonly<{
    clientAuthenticationMethod: string;
    clientSecretPost: string;
    clientSecretBasic: string;
    storeRefreshToken: string;
    buttonColor: string;
    iconHint: string;
    allowRulesHint: string;
    brandingHint: string;
    invalidScopes: string;
    refreshFailed: string;
    refreshFailedHint: string;
}>;

const oidcEditorWords: Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>> = {
    en: {
        clientAuthenticationMethod: 'Client authentication', clientSecretPost: 'POST body', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Store refresh token', buttonColor: 'Sign-in button color', iconHint: 'Sign-in icon',
        allowRulesHint: 'Enter one value per line. Leave blank for no restriction.', brandingHint: 'Leave blank to use the default sign-in appearance.', invalidScopes: 'Include openid in the requested scopes.', refreshFailed: 'Couldn’t refresh this connection', refreshFailedHint: 'Your edits are kept. Retry to check for changes on the Home.',
    },
    fr: {
        clientAuthenticationMethod: 'Authentification du client', clientSecretPost: 'Corps POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Conserver le jeton de renouvellement', buttonColor: 'Couleur du bouton de connexion', iconHint: 'Icône de connexion',
        allowRulesHint: 'Saisissez une valeur par ligne. Laissez vide pour ne pas restreindre.', brandingHint: 'Laissez vide pour utiliser l’apparence de connexion par défaut.', invalidScopes: 'Incluez openid dans les portées demandées.', refreshFailed: 'Impossible d’actualiser cette connexion', refreshFailedHint: 'Vos modifications sont conservées. Réessayez pour vérifier les changements sur le Home.',
    },
    es: {
        clientAuthenticationMethod: 'Autenticación del cliente', clientSecretPost: 'Cuerpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Guardar token de renovación', buttonColor: 'Color del botón de acceso', iconHint: 'Icono de acceso',
        allowRulesHint: 'Introduce un valor por línea. Déjalo vacío para no restringir.', brandingHint: 'Déjalo vacío para usar la apariencia de acceso predeterminada.', invalidScopes: 'Incluye openid en los ámbitos solicitados.', refreshFailed: 'No se pudo actualizar esta conexión', refreshFailedHint: 'Tus cambios se conservan. Reintenta para comprobar los cambios en el Home.',
    },
    de: {
        clientAuthenticationMethod: 'Client-Authentifizierung', clientSecretPost: 'POST-Nachrichtentext', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Aktualisierungstoken speichern', buttonColor: 'Farbe der Anmeldeschaltfläche', iconHint: 'Anmeldesymbol',
        allowRulesHint: 'Einen Wert pro Zeile eingeben. Leer lassen für keine Einschränkung.', brandingHint: 'Leer lassen, um die Standarddarstellung zu verwenden.', invalidScopes: 'Nimm openid in die angeforderten Bereiche auf.', refreshFailed: 'Diese Verbindung konnte nicht aktualisiert werden', refreshFailedHint: 'Deine Änderungen bleiben erhalten. Versuche erneut, Änderungen auf dem Home abzurufen.',
    },
    it: {
        clientAuthenticationMethod: 'Autenticazione del client', clientSecretPost: 'Corpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Conserva il token di rinnovo', buttonColor: 'Colore del pulsante di accesso', iconHint: 'Icona di accesso',
        allowRulesHint: 'Inserisci un valore per riga. Lascia vuoto per non applicare restrizioni.', brandingHint: 'Lascia vuoto per usare l’aspetto di accesso predefinito.', invalidScopes: 'Includi openid negli ambiti richiesti.', refreshFailed: 'Impossibile aggiornare questa connessione', refreshFailedHint: 'Le tue modifiche sono conservate. Riprova per controllare le modifiche sul Home.',
    },
    pt: {
        clientAuthenticationMethod: 'Autenticação do cliente', clientSecretPost: 'Corpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Guardar token de renovação', buttonColor: 'Cor do botão de início de sessão', iconHint: 'Ícone de início de sessão',
        allowRulesHint: 'Introduz um valor por linha. Deixa em branco para não restringir.', brandingHint: 'Deixa em branco para usar o aspeto de início de sessão predefinido.', invalidScopes: 'Inclui openid nos âmbitos pedidos.', refreshFailed: 'Não foi possível atualizar esta ligação', refreshFailedHint: 'As tuas alterações foram mantidas. Tenta novamente para verificar alterações no Home.',
    },
    ca: {
        clientAuthenticationMethod: 'Autenticació del client', clientSecretPost: 'Cos POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Desa el testimoni de renovació', buttonColor: 'Color del botó d’accés', iconHint: 'Icona d’accés',
        allowRulesHint: 'Introdueix un valor per línia. Deixa-ho buit per no restringir.', brandingHint: 'Deixa-ho buit per utilitzar l’aparença d’accés predeterminada.', invalidScopes: 'Inclou openid en els àmbits sol·licitats.', refreshFailed: 'No s’ha pogut actualitzar aquesta connexió', refreshFailedHint: 'Els canvis es conserven. Torna-ho a provar per comprovar els canvis al Home.',
    },
    pl: {
        clientAuthenticationMethod: 'Uwierzytelnianie klienta', clientSecretPost: 'Treść POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Przechowuj token odświeżania', buttonColor: 'Kolor przycisku logowania', iconHint: 'Ikona logowania',
        allowRulesHint: 'Wpisz jedną wartość w każdym wierszu. Puste pole oznacza brak ograniczeń.', brandingHint: 'Pozostaw puste, aby użyć domyślnego wyglądu logowania.', invalidScopes: 'Uwzględnij openid w żądanych zakresach.', refreshFailed: 'Nie udało się odświeżyć tego połączenia', refreshFailedHint: 'Twoje zmiany zostały zachowane. Ponów próbę, aby sprawdzić zmiany w Home.',
    },
    ru: {
        clientAuthenticationMethod: 'Аутентификация клиента', clientSecretPost: 'Тело POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Хранить токен обновления', buttonColor: 'Цвет кнопки входа', iconHint: 'Значок входа',
        allowRulesHint: 'Введите по одному значению в строке. Пустое поле означает отсутствие ограничений.', brandingHint: 'Оставьте пустым для стандартного оформления входа.', invalidScopes: 'Включите openid в запрашиваемые области.', refreshFailed: 'Не удалось обновить это подключение', refreshFailedHint: 'Ваши изменения сохранены. Повторите попытку, чтобы проверить изменения в Home.',
    },
    ja: {
        clientAuthenticationMethod: 'クライアント認証', clientSecretPost: 'POST 本文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '更新トークンを保存', buttonColor: 'サインインボタンの色', iconHint: 'サインインアイコン',
        allowRulesHint: '1 行に 1 つの値を入力します。空欄の場合は制限しません。', brandingHint: '既定のサインイン表示を使う場合は空欄にします。', invalidScopes: '要求するスコープに openid を含めてください。', refreshFailed: 'この接続を更新できませんでした', refreshFailedHint: '編集内容は保持されています。Home の変更を確認するには再試行してください。',
    },
    zhHans: {
        clientAuthenticationMethod: '客户端身份验证', clientSecretPost: 'POST 正文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '保存刷新令牌', buttonColor: '登录按钮颜色', iconHint: '登录图标',
        allowRulesHint: '每行输入一个值。留空表示不限制。', brandingHint: '留空以使用默认登录外观。', invalidScopes: '请求的范围必须包含 openid。', refreshFailed: '无法刷新此连接', refreshFailedHint: '你的编辑已保留。重试以检查 Home 上的更改。',
    },
    zhHant: {
        clientAuthenticationMethod: '用戶端驗證', clientSecretPost: 'POST 本文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '儲存更新權杖', buttonColor: '登入按鈕顏色', iconHint: '登入圖示',
        allowRulesHint: '每行輸入一個值。留空表示不限制。', brandingHint: '留空以使用預設登入外觀。', invalidScopes: '要求的範圍必須包含 openid。', refreshFailed: '無法更新此連線', refreshFailedHint: '你的編輯已保留。重試以檢查 Home 上的變更。',
    },
};

function build(w: Words, language: keyof typeof githubAccessWords = 'en') {
    return {
        identityAdministration: {
            ...w,
            ...githubAccessWords[language],
            ...oidcEditorWords[language],
            workos: 'WorkOS',
            workosSetupSso: `${w.add}: WorkOS SSO`,
            workosSetupDirectory: `${w.add}: WorkOS Directory Sync`,
            workosCheckSetup: `${w.configuration}: WorkOS`,
            workosChooseConnection: `${w.configuration}: WorkOS SSO`,
            providerOidc: 'OpenID Connect',
            providerWorkosSso: 'WorkOS SSO',
            providerGitHub: 'GitHub',
            workosStrategySaml: 'SAML',
            workosStrategyOidc: 'OpenID Connect',
            workosStrategyOther: 'Other sign-in strategy',
            workosStatusUnknown: 'Status unavailable',
            teamRemoveImpact: ({ accounts, alternateLogins, directories, groups, memberships }: { accounts: number; alternateLogins: number; directories: number; groups: number; memberships: number }) => `${w.accounts}: ${accounts}. ${w.alternateLogins}: ${alternateLogins}. Directory: ${directories}. Groups: ${groups}. Managed memberships: ${memberships}.`,
            removeTitle: ({ name }: { name: string }) => `${w.remove}: ${name}?`,
            removeBody: ({ name }: { name: string }) => `${name}: ${w.remove}.`,
            removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `${w.accounts}: ${accounts}. ${w.connections}: ${connections}.`,
            githubApps: 'GitHub Apps',
            githubAppsSubtitle: 'Home-owned GitHub Apps and their verified organization installations.',
            githubAppsEmpty: 'No GitHub Apps configured',
            githubAppAdd: 'Add GitHub App',
            githubAppCreateTitle: 'Add GitHub App',
            githubAppEditTitle: 'Edit GitHub App',
            githubHost: 'GitHub host',
            githubAppId: 'GitHub App ID',
            githubClientId: 'Client ID',
            githubAppSlug: 'App slug',
            githubOwnerLogin: 'Owner login',
            githubPrivateKey: 'Private key',
            githubWebhookSecret: 'Webhook secret',
            githubSecretsRetain: 'Leave secret fields blank to keep their current values.',
            githubInstallations: 'Organization installations',
            githubInstallationsEmpty: 'No verified installations',
            githubOrganization: 'Organization',
            githubRepositorySelection: 'Repository access',
            githubAllRepositories: 'All repositories',
            githubSelectedRepositories: 'Selected repositories',
            githubConsumers: 'Use this App',
            githubConsumersSubtitle: 'Sign-in and directory sync are configured separately after the installation is verified.',
            teamConsumers: 'Team consumers',
            teamConsumersSubtitle: 'Each Team binding enables only the identity or directory facet shown here.',
            githubRequiredAccess: 'Required access',
            githubRequiredAccessSubtitle: 'What the Teams using this App need GitHub to grant. Change the App on GitHub, then verify the installation again.',
            githubRequiredAccessSatisfied: 'This installation already grants everything its Teams need.',
            githubRequiredPermission: ({ level }: { level: string }) => `Permission, ${level}`,
            githubRequiredEvent: 'Webhook event',
            githubRequirementGranted: 'Granted',
            githubRequirementMissing: 'Missing',
            githubFacetSignIn: 'Sign in with GitHub',
            githubFacetSignInSubtitle: 'Choose this installation from the identity connections managed by its owner.',
            githubFacetDirectory: 'Directory sync',
            githubFacetDirectorySubtitle: 'Create a directory source from this verified installation.',
            githubFacetConfigure: 'Configure separately',
            githubVerifyInstallation: 'Verify installation',
            githubInstallationId: 'GitHub installation ID',
            githubOrganizationId: 'GitHub organization ID',
            githubOpeningVerification: 'Opening GitHub verification…',
            githubRemoveInstallation: 'Remove installation',
            githubRemoveInstallationTitle: ({ name }: { name: string }) => `${w.remove}: ${name}?`,
            githubRemoveInstallationBody: ({ name }: { name: string }) => `${name}: ${w.remove}.`,
            githubInstallationInUse: 'This installation is still used by an identity connection or directory source.',
            githubDraft: 'Draft',
            githubVerified: 'Verified',
            githubNeedsAttention: 'Needs attention',
            githubRequired: 'Complete the required GitHub App fields.',
            githubEnterpriseOriginNotApproved: 'This GitHub Enterprise host is not approved by this Home. Your changes are kept here. Open Home Policies, approve the exact HTTPS origin, then return and try again.',
            githubManifestSetup: 'Set up with GitHub',
            githubManifestSetupSubtitle: 'Create and register the App in GitHub, then return here automatically.',
            githubAppName: 'App name',
            githubOrganizationOwner: 'Create for an organization',
            githubOrganizationLogin: 'Organization login',
            githubOpeningSetup: 'Opening GitHub setup…',
            githubManualSetup: 'Manual configuration',
            eligibleProviders: 'Add connection',
            providerOwnerHome: 'Managed by Home',
            providerOwnerTeam: 'Managed by Team',
            providerUnavailable: 'Unavailable',
            providerUseExisting: 'Use connection',
            providerSetup: 'Set up provider',
            providerContactAdmin: 'Contact a Home administrator',
            settingsChangedElsewhere: 'This connection changed on the Home while you were editing. Your changes are kept — review them, then save again.',
            groupsAny: 'Any of these Groups',
            groupsAll: 'All of these Groups',
            disableTitle: ({ name }: { name: string }) => `${w.disable}: ${name}?`,
            disableBody: ({ name }: { name: string }) => `${name}: ${w.disabled}.`,
            diagnosticsTitle: 'Last test result',
            diagnosticsSubject: 'Subject',
            diagnosticsPresent: 'Present',
            diagnosticsMissing: 'Missing',
            diagnosticsLogin: 'Sign-in name',
            diagnosticsEmail: 'Email address',
            diagnosticsProvided: 'Provided',
            diagnosticsNotProvided: 'Not provided',
            diagnosticsEmailVerified: 'Provided and verified',
            diagnosticsEmailUnverified: 'Provided, not verified',
            diagnosticsGroups: 'Groups claim',
            diagnosticsGroupsCount: ({ count }: { count: number }) => `${count} received`,
            diagnosticsGroupsIncomplete: 'Incomplete',
            diagnosticsEligibility: 'Eligibility',
            diagnosticsEligible: 'Eligible',
            diagnosticsIneligible: 'Not eligible',
            diagnosticsNoRules: 'No restrictions configured',
            diagnosticsRuleUsers: 'Allowed users',
            diagnosticsRuleEmailDomains: 'Allowed email domains',
            diagnosticsRuleMatched: 'Matched',
            diagnosticsRuleUnmatched: 'Not matched',
            diagnosticsMappedGroups: 'Mapped Team Groups',
            diagnosticsMappedGroupsEmpty: 'No mapping matched',
            diagnosticsMappedGroupsUnavailable: 'Not evaluated',
            diagnosticsFooter: 'Nothing was changed by this test. No Account, membership, or Group was written.',
        },
    };
}

const en: Words = {
    title: 'Identity providers', subtitle: 'Home-owned sign-in connections available to Teams.', homeConnections: 'Home sign-in connections', add: 'Add connection', empty: 'No Home sign-in connections', unreadable: 'Some provider records could not be read.', active: 'Active', disabled: 'Disabled', needsTest: 'Test required', tested: 'Tested', staleTest: 'Retest required', configuration: 'Configuration', issuer: 'Issuer URL', clientId: 'Client ID', clientSecret: 'Client secret', secretSet: 'Set', secretNotSet: 'Not set', secretNeedsAttention: 'Needs attention', secretRepair: 'Replace the client secret to repair this connection.', secretRetain: 'Leave blank to keep the current secret.', scopes: 'Scopes', loginClaim: 'Login claim', emailClaim: 'Email claim', groupsClaim: 'Groups claim', fetchUserInfo: 'Fetch UserInfo', advanced: 'Show advanced settings', hideAdvanced: 'Hide advanced settings', actions: 'Actions', test: 'Test sign-in', testing: 'Opening sign-in test…', validate: 'Validate configuration', validating: 'Validating configuration…', validated: 'Configuration valid', edit: 'Edit connection', save: 'Save connection', saving: 'Saving…', enable: 'Enable connection', disable: 'Disable connection', remove: 'Remove connection', createTitle: 'Add identity provider', editTitle: 'Edit identity provider', displayName: 'Name', required: 'Complete the required fields.', invalidIssuer: 'Enter a valid HTTPS issuer URL.', secretRequired: 'Enter a client secret.', error: 'That did not go through. Nothing was changed.', errorForbidden: 'You no longer have permission for this. Nothing was changed.', errorConflict: 'Someone else changed this first. Your edits are kept — reload, then try again.', errorMissing: 'This no longer exists. Someone else may have removed it.', errorInUse: 'Something still depends on this. Remove those first.', errorProviderUnavailable: 'The identity service did not respond. Nothing was changed.', errorRateLimited: 'The provider asked us to wait before trying again.', errorInvalid: 'The Home rejected these values. Check the configuration and try again.', errorImmutable: 'This value is fixed once the record is in use. Create a new one instead.', accounts: 'Affected Accounts', connections: 'Team connections', directoryGroups: 'Directory Groups', searchGroups: 'Search directory Groups', mapCreate: 'Create and manage a Team Group', mapExisting: 'Map to an existing Team Group', mappedTo: 'Mapped to', unmapped: 'Not mapped', chooseGroup: 'Choose a Team Group', loadMore: 'Load more Groups', removeMapping: 'Remove Group mapping', errorAuthenticationRequired: 'Sign in to this Team again, then retry. Nothing was changed.', errorPolicyUnavailable: 'The Team\u2019s authentication policy cannot be evaluated right now. Nothing was changed.', errorPolicyInUse: 'The Team\u2019s authentication policy still depends on this connection.', errorNotAllowed: 'This Home does not let Teams configure this. Nothing was changed.', errorNeedsAttention: 'Directory sync needs attention. Run a full sync.', errorSyncPaused: 'This source is paused. Resume sync to start a fresh full sync.', alternateLogins: 'Accounts needing another way to sign in', recoveryAuthenticationPolicy: 'Open Team authentication', recoveryAlternateLogin: 'Give those Accounts another way to sign in first', recoveryDirectory: 'Open Directory', recoveryGroupMappings: 'Open Group mappings', recoveryTeamAuthentication: 'Sign in again', callbackUrl: 'Callback URL', callbackUrlHint: 'Register this URL with your identity provider.',
};

export const identityAdministrationTranslations = {
    en: build(en),
    fr: build({ ...en, title: 'Fournisseurs d’identité', subtitle: 'Connexions de connexion du Home disponibles pour les Teams.', homeConnections: 'Connexions du Home', add: 'Ajouter une connexion', empty: 'Aucune connexion du Home', unreadable: 'Certains fournisseurs sont illisibles.', active: 'Actif', disabled: 'Désactivé', needsTest: 'Test requis', tested: 'Testé', staleTest: 'Nouveau test requis', configuration: 'Configuration', issuer: 'URL de l’émetteur', clientId: 'ID client', clientSecret: 'Secret client', secretSet: 'Défini', secretNotSet: 'Non défini', secretRetain: 'Laisser vide pour conserver le secret actuel.', scopes: 'Portées', loginClaim: 'Attribut de connexion', emailClaim: 'Attribut e-mail', groupsClaim: 'Attribut des Groupes', fetchUserInfo: 'Récupérer UserInfo', advanced: 'Afficher les réglages avancés', hideAdvanced: 'Masquer les réglages avancés', actions: 'Actions', test: 'Tester la connexion', testing: 'Ouverture du test…', edit: 'Modifier la connexion', save: 'Enregistrer', saving: 'Enregistrement…', enable: 'Activer la connexion', disable: 'Désactiver la connexion', remove: 'Supprimer la connexion', createTitle: 'Ajouter un fournisseur d’identité', editTitle: 'Modifier le fournisseur d’identité', displayName: 'Nom', required: 'Renseignez les champs obligatoires.', invalidIssuer: 'Saisissez une URL HTTPS valide.', secretRequired: 'Saisissez un secret client.', error: 'La modification a échoué.', accounts: 'Accounts concernés', connections: 'Connexions Team', errorForbidden: 'Vous n’avez plus l’autorisation. Rien n’a été modifié.', errorConflict: 'Quelqu’un a modifié cet élément avant vous. Vos modifications sont conservées : rechargez, puis réessayez.', errorMissing: 'Cet élément n’existe plus. Quelqu’un l’a peut-être supprimé.', errorInUse: 'D’autres éléments en dépendent encore. Supprimez-les d’abord.', errorProviderUnavailable: 'Le service d’identité n’a pas répondu. Rien n’a été modifié.', errorRateLimited: 'Le fournisseur demande d’attendre avant un nouvel essai.', errorInvalid: 'Le Home a refusé ces valeurs. Vérifiez la configuration et réessayez.', errorImmutable: 'Cette valeur est figée une fois l’enregistrement utilisé. Créez-en un nouveau.', errorAuthenticationRequired: 'Reconnectez-vous à cette Team, puis réessayez. Rien n’a été modifié.', errorPolicyUnavailable: 'La politique d’authentification de la Team ne peut pas être évaluée pour le moment. Rien n’a été modifié.', errorPolicyInUse: 'La politique d’authentification de la Team dépend encore de cette connexion.', errorNotAllowed: 'Ce Home n’autorise pas les Teams à configurer ceci. Rien n’a été modifié.', errorNeedsAttention: 'La synchronisation de l’annuaire nécessite votre attention. Lancez une synchronisation complète.', errorSyncPaused: 'Cette source est suspendue. « Reprendre la synchronisation » lance une nouvelle synchronisation complète.', alternateLogins: 'Accounts nécessitant une autre méthode de connexion', recoveryAuthenticationPolicy: 'Ouvrir l’authentification de la Team', recoveryAlternateLogin: 'Donnez d’abord une autre méthode de connexion à ces Accounts', recoveryDirectory: 'Ouvrir l’annuaire', recoveryGroupMappings: 'Ouvrir les correspondances de Groupes', recoveryTeamAuthentication: 'Se reconnecter', callbackUrl: 'URL de rappel', callbackUrlHint: 'Enregistrez cette URL auprès de votre fournisseur d’identité.' }, 'fr'),
    es: build({ ...en, title: 'Proveedores de identidad', subtitle: 'Conexiones de acceso del Home disponibles para Teams.', homeConnections: 'Conexiones del Home', add: 'Añadir conexión', empty: 'No hay conexiones del Home', active: 'Activo', disabled: 'Desactivado', configuration: 'Configuración', issuer: 'URL del emisor', clientSecret: 'Secreto del cliente', secretSet: 'Configurado', secretNotSet: 'Sin configurar', secretRetain: 'Déjalo vacío para conservar el secreto actual.', advanced: 'Mostrar ajustes avanzados', hideAdvanced: 'Ocultar ajustes avanzados', test: 'Probar acceso', testing: 'Abriendo la prueba…', edit: 'Editar conexión', save: 'Guardar conexión', saving: 'Guardando…', enable: 'Activar conexión', disable: 'Desactivar conexión', remove: 'Eliminar conexión', createTitle: 'Añadir proveedor de identidad', editTitle: 'Editar proveedor de identidad', displayName: 'Nombre', required: 'Completa los campos obligatorios.', invalidIssuer: 'Introduce una URL HTTPS válida.', secretRequired: 'Introduce un secreto del cliente.', error: 'El cambio no se realizó.', accounts: 'Accounts afectados', connections: 'Conexiones de Team', errorForbidden: 'Ya no tienes permiso para esto. No se cambió nada.', errorConflict: 'Otra persona lo cambió antes. Tus ediciones se conservan: recarga y vuelve a intentarlo.', errorMissing: 'Esto ya no existe. Puede que alguien lo haya eliminado.', errorInUse: 'Algo todavía depende de esto. Elimínalo primero.', errorProviderUnavailable: 'El servicio de identidad no respondió. No se cambió nada.', errorRateLimited: 'El proveedor pidió esperar antes de reintentar.', errorInvalid: 'El Home rechazó estos valores. Revisa la configuración e inténtalo de nuevo.', errorImmutable: 'Este valor queda fijo cuando el registro está en uso. Crea uno nuevo.', errorAuthenticationRequired: 'Vuelve a iniciar sesión en este Team y reintenta. No se cambió nada.', errorPolicyUnavailable: 'La política de autenticación del Team no se puede evaluar ahora. No se cambió nada.', errorPolicyInUse: 'La política de autenticación del Team aún depende de esta conexión.', errorNotAllowed: 'Este Home no permite que los Teams configuren esto. No se cambió nada.', errorNeedsAttention: 'La sincronización del directorio requiere atención. Ejecuta una sincronización completa.', errorSyncPaused: 'Esta fuente está en pausa. «Reanudar sincronización» inicia una nueva sincronización completa.', alternateLogins: 'Accounts que necesitan otro método de acceso', recoveryAuthenticationPolicy: 'Abrir autenticación del Team', recoveryAlternateLogin: 'Da primero otro método de acceso a esas Accounts', recoveryDirectory: 'Abrir directorio', recoveryGroupMappings: 'Abrir asignaciones de Grupos', recoveryTeamAuthentication: 'Volver a iniciar sesión', callbackUrl: 'URL de retorno', callbackUrlHint: 'Registra esta URL en tu proveedor de identidad.' }, 'es'),
    de: build({ ...en, title: 'Identitätsanbieter', subtitle: 'Home-Anmeldeverbindungen für Teams.', homeConnections: 'Home-Anmeldeverbindungen', add: 'Verbindung hinzufügen', empty: 'Keine Home-Anmeldeverbindungen', active: 'Aktiv', disabled: 'Deaktiviert', configuration: 'Konfiguration', issuer: 'Aussteller-URL', clientSecret: 'Client-Geheimnis', secretSet: 'Gesetzt', secretNotSet: 'Nicht gesetzt', secretRetain: 'Leer lassen, um das aktuelle Geheimnis zu behalten.', advanced: 'Erweiterte Einstellungen anzeigen', hideAdvanced: 'Erweiterte Einstellungen ausblenden', actions: 'Aktionen', test: 'Anmeldung testen', testing: 'Anmeldetest wird geöffnet…', edit: 'Verbindung bearbeiten', save: 'Verbindung speichern', saving: 'Wird gespeichert…', enable: 'Verbindung aktivieren', disable: 'Verbindung deaktivieren', remove: 'Verbindung entfernen', createTitle: 'Identitätsanbieter hinzufügen', editTitle: 'Identitätsanbieter bearbeiten', displayName: 'Name', required: 'Pflichtfelder ausfüllen.', invalidIssuer: 'Eine gültige HTTPS-Aussteller-URL eingeben.', secretRequired: 'Client-Geheimnis eingeben.', error: 'Die Änderung wurde nicht übernommen.', accounts: 'Betroffene Accounts', connections: 'Team-Verbindungen', errorForbidden: 'Du hast dafür keine Berechtigung mehr. Es wurde nichts geändert.', errorConflict: 'Jemand anderes war schneller. Deine Änderungen bleiben erhalten – neu laden und erneut speichern.', errorMissing: 'Das gibt es nicht mehr. Möglicherweise wurde es entfernt.', errorInUse: 'Etwas hängt noch davon ab. Entferne das zuerst.', errorProviderUnavailable: 'Der Identitätsdienst hat nicht geantwortet. Es wurde nichts geändert.', errorRateLimited: 'Der Anbieter bittet darum, vor dem nächsten Versuch zu warten.', errorInvalid: 'Das Home hat diese Werte abgelehnt. Prüfe die Konfiguration und versuche es erneut.', errorImmutable: 'Dieser Wert ist nach der Nutzung fest. Lege stattdessen einen neuen Eintrag an.', errorAuthenticationRequired: 'Melde dich erneut bei diesem Team an und versuche es dann noch einmal. Nichts wurde geändert.', errorPolicyUnavailable: 'Die Authentifizierungsrichtlinie des Teams kann gerade nicht ausgewertet werden. Nichts wurde geändert.', errorPolicyInUse: 'Die Authentifizierungsrichtlinie des Teams hängt noch von dieser Verbindung ab.', errorNotAllowed: 'Dieses Home erlaubt Teams diese Konfiguration nicht. Nichts wurde geändert.', errorNeedsAttention: 'Die Verzeichnissynchronisierung braucht Aufmerksamkeit. Starte eine vollständige Synchronisierung.', errorSyncPaused: 'Diese Quelle ist pausiert. „Synchronisierung fortsetzen“ startet eine neue vollständige Synchronisierung.', alternateLogins: 'Accounts, die eine andere Anmeldemethode brauchen', recoveryAuthenticationPolicy: 'Team-Authentifizierung öffnen', recoveryAlternateLogin: 'Gib diesen Accounts zuerst eine andere Anmeldemethode', recoveryDirectory: 'Verzeichnis öffnen', recoveryGroupMappings: 'Gruppenzuordnungen öffnen', recoveryTeamAuthentication: 'Erneut anmelden', callbackUrl: 'Callback-URL', callbackUrlHint: 'Registriere diese URL bei deinem Identitätsanbieter.' }, 'de'),
    it: build({ ...en, title: 'Provider di identità', subtitle: 'Connessioni di accesso del Home disponibili ai Team.', homeConnections: 'Connessioni del Home', add: 'Aggiungi connessione', empty: 'Nessuna connessione del Home', active: 'Attivo', disabled: 'Disattivato', configuration: 'Configurazione', issuer: 'URL emittente', clientSecret: 'Segreto client', secretSet: 'Impostato', secretNotSet: 'Non impostato', secretRetain: 'Lascia vuoto per mantenere il segreto corrente.', advanced: 'Mostra impostazioni avanzate', hideAdvanced: 'Nascondi impostazioni avanzate', actions: 'Azioni', test: 'Prova accesso', testing: 'Apertura della prova…', edit: 'Modifica connessione', save: 'Salva connessione', saving: 'Salvataggio…', enable: 'Attiva connessione', disable: 'Disattiva connessione', remove: 'Rimuovi connessione', createTitle: 'Aggiungi provider di identità', editTitle: 'Modifica provider di identità', displayName: 'Nome', required: 'Completa i campi obbligatori.', invalidIssuer: 'Inserisci un URL HTTPS valido.', secretRequired: 'Inserisci un segreto client.', error: 'La modifica non è riuscita.', accounts: 'Account interessati', connections: 'Connessioni Team', errorForbidden: 'Non hai più l’autorizzazione. Non è stato modificato nulla.', errorConflict: 'Qualcun altro l’ha modificato prima. Le tue modifiche sono conservate: ricarica e riprova.', errorMissing: 'Non esiste più. Potrebbe essere stato rimosso.', errorInUse: 'Qualcosa dipende ancora da questo. Rimuovilo prima.', errorProviderUnavailable: 'Il servizio di identità non ha risposto. Non è stato modificato nulla.', errorRateLimited: 'Il provider ha chiesto di attendere prima di riprovare.', errorInvalid: 'Il Home ha rifiutato questi valori. Controlla la configurazione e riprova.', errorImmutable: 'Questo valore è fisso quando il record è in uso. Creane uno nuovo.', errorAuthenticationRequired: 'Accedi di nuovo a questo Team, poi riprova. Nulla è stato modificato.', errorPolicyUnavailable: 'Il criterio di autenticazione del Team non può essere valutato al momento. Nulla è stato modificato.', errorPolicyInUse: 'Il criterio di autenticazione del Team dipende ancora da questa connessione.', errorNotAllowed: 'Questo Home non consente ai Team di configurare questo. Nulla è stato modificato.', errorNeedsAttention: 'La sincronizzazione della directory richiede attenzione. Esegui una sincronizzazione completa.', errorSyncPaused: 'Questa sorgente è in pausa. «Riprendi sincronizzazione» avvia una nuova sincronizzazione completa.', alternateLogins: 'Account che necessitano di un altro metodo di accesso', recoveryAuthenticationPolicy: 'Apri autenticazione del Team', recoveryAlternateLogin: 'Assegna prima un altro metodo di accesso a questi Account', recoveryDirectory: 'Apri directory', recoveryGroupMappings: 'Apri mappature dei Gruppi', recoveryTeamAuthentication: 'Accedi di nuovo', callbackUrl: 'URL di callback', callbackUrlHint: 'Registra questo URL presso il tuo provider di identità.' }, 'it'),
    pt: build({ ...en, title: 'Fornecedores de identidade', subtitle: 'Ligações de início de sessão do Home disponíveis para Teams.', homeConnections: 'Ligações do Home', add: 'Adicionar ligação', empty: 'Sem ligações do Home', active: 'Ativo', disabled: 'Desativado', configuration: 'Configuração', issuer: 'URL do emissor', clientSecret: 'Segredo do cliente', secretSet: 'Definido', secretNotSet: 'Não definido', secretRetain: 'Deixe vazio para manter o segredo atual.', advanced: 'Mostrar definições avançadas', hideAdvanced: 'Ocultar definições avançadas', actions: 'Ações', test: 'Testar início de sessão', testing: 'A abrir teste…', edit: 'Editar ligação', save: 'Guardar ligação', saving: 'A guardar…', enable: 'Ativar ligação', disable: 'Desativar ligação', remove: 'Remover ligação', createTitle: 'Adicionar fornecedor de identidade', editTitle: 'Editar fornecedor de identidade', displayName: 'Nome', required: 'Preencha os campos obrigatórios.', invalidIssuer: 'Introduza um URL HTTPS válido.', secretRequired: 'Introduza um segredo do cliente.', error: 'A alteração não foi aplicada.', accounts: 'Accounts afetados', connections: 'Ligações de Team', errorForbidden: 'Já não tem permissão para isto. Nada foi alterado.', errorConflict: 'Outra pessoa alterou isto primeiro. As suas edições foram mantidas: recarregue e tente novamente.', errorMissing: 'Isto já não existe. Pode ter sido removido.', errorInUse: 'Algo ainda depende disto. Remova-o primeiro.', errorProviderUnavailable: 'O serviço de identidade não respondeu. Nada foi alterado.', errorRateLimited: 'O fornecedor pediu para aguardar antes de tentar de novo.', errorInvalid: 'O Home rejeitou estes valores. Verifique a configuração e tente novamente.', errorImmutable: 'Este valor fica fixo quando o registo está em uso. Crie um novo.', errorAuthenticationRequired: 'Inicie sessão novamente nesta Team e tente de novo. Nada foi alterado.', errorPolicyUnavailable: 'A política de autenticação da Team não pode ser avaliada agora. Nada foi alterado.', errorPolicyInUse: 'A política de autenticação da Team ainda depende desta ligação.', errorNotAllowed: 'Este Home não permite que as Teams configurem isto. Nada foi alterado.', errorNeedsAttention: 'A sincronização do diretório requer atenção. Execute uma sincronização completa.', errorSyncPaused: 'Esta fonte está em pausa. «Retomar sincronização» inicia uma nova sincronização completa.', alternateLogins: 'Accounts que precisam de outro método de início de sessão', recoveryAuthenticationPolicy: 'Abrir autenticação da Team', recoveryAlternateLogin: 'Dê primeiro outro método de início de sessão a essas Accounts', recoveryDirectory: 'Abrir diretório', recoveryGroupMappings: 'Abrir mapeamentos de Grupos', recoveryTeamAuthentication: 'Iniciar sessão novamente', callbackUrl: 'URL de callback', callbackUrlHint: 'Registe este URL no seu fornecedor de identidade.' }, 'pt'),
    ca: build({ ...en, title: 'Proveïdors d’identitat', subtitle: 'Connexions d’accés del Home disponibles per als Teams.', homeConnections: 'Connexions del Home', add: 'Afegeix una connexió', empty: 'No hi ha connexions del Home', active: 'Activa', disabled: 'Desactivada', configuration: 'Configuració', issuer: 'URL de l’emissor', clientSecret: 'Secret del client', secretSet: 'Definit', secretNotSet: 'No definit', secretRetain: 'Deixa-ho buit per conservar el secret actual.', advanced: 'Mostra opcions avançades', hideAdvanced: 'Amaga opcions avançades', actions: 'Accions', test: 'Prova l’accés', testing: 'S’està obrint la prova…', edit: 'Edita la connexió', save: 'Desa la connexió', saving: 'S’està desant…', enable: 'Activa la connexió', disable: 'Desactiva la connexió', remove: 'Elimina la connexió', createTitle: 'Afegeix un proveïdor d’identitat', editTitle: 'Edita el proveïdor d’identitat', displayName: 'Nom', required: 'Completa els camps obligatoris.', invalidIssuer: 'Introdueix un URL HTTPS vàlid.', secretRequired: 'Introdueix un secret del client.', error: 'El canvi no s’ha aplicat.', accounts: 'Accounts afectats', connections: 'Connexions del Team', errorForbidden: 'Ja no tens permís per a això. No s’ha canviat res.', errorConflict: 'Algú altre ho ha canviat abans. Els teus canvis es conserven: torna a carregar i prova-ho de nou.', errorMissing: 'Això ja no existeix. Pot ser que algú ho hagi eliminat.', errorInUse: 'Encara hi ha coses que en depenen. Elimina-les primer.', errorProviderUnavailable: 'El servei d’identitat no ha respost. No s’ha canviat res.', errorRateLimited: 'El proveïdor demana esperar abans de tornar-ho a provar.', errorInvalid: 'El Home ha rebutjat aquests valors. Revisa la configuració i torna-ho a provar.', errorImmutable: 'Aquest valor queda fix quan el registre s’usa. Crea’n un de nou.', errorAuthenticationRequired: 'Torna a iniciar la sessió en aquest Team i torna-ho a provar. No s’ha canviat res.', errorPolicyUnavailable: 'La política d’autenticació del Team no es pot avaluar ara mateix. No s’ha canviat res.', errorPolicyInUse: 'La política d’autenticació del Team encara depèn d’aquesta connexió.', errorNotAllowed: 'Aquest Home no permet que els Teams configurin això. No s’ha canviat res.', errorNeedsAttention: 'La sincronització del directori requereix atenció. Executa una sincronització completa.', errorSyncPaused: 'Aquesta font està en pausa. «Reprèn la sincronització» inicia una sincronització completa nova.', alternateLogins: 'Accounts que necessiten un altre mètode d’accés', recoveryAuthenticationPolicy: 'Obre l’autenticació del Team', recoveryAlternateLogin: 'Dona primer un altre mètode d’accés a aquests Accounts', recoveryDirectory: 'Obre el directori', recoveryGroupMappings: 'Obre les assignacions de Grups', recoveryTeamAuthentication: 'Torna a iniciar la sessió', callbackUrl: 'URL de retorn', callbackUrlHint: 'Registra aquesta URL al teu proveïdor d’identitat.' }, 'ca'),
    pl: build({ ...en, title: 'Dostawcy tożsamości', subtitle: 'Połączenia logowania Home dostępne dla Teamów.', homeConnections: 'Połączenia Home', add: 'Dodaj połączenie', empty: 'Brak połączeń Home', active: 'Aktywne', disabled: 'Wyłączone', configuration: 'Konfiguracja', issuer: 'URL wystawcy', clientSecret: 'Sekret klienta', secretSet: 'Ustawiony', secretNotSet: 'Nieustawiony', secretRetain: 'Pozostaw puste, aby zachować bieżący sekret.', advanced: 'Pokaż ustawienia zaawansowane', hideAdvanced: 'Ukryj ustawienia zaawansowane', actions: 'Działania', test: 'Testuj logowanie', testing: 'Otwieranie testu…', edit: 'Edytuj połączenie', save: 'Zapisz połączenie', saving: 'Zapisywanie…', enable: 'Włącz połączenie', disable: 'Wyłącz połączenie', remove: 'Usuń połączenie', createTitle: 'Dodaj dostawcę tożsamości', editTitle: 'Edytuj dostawcę tożsamości', displayName: 'Nazwa', required: 'Uzupełnij wymagane pola.', invalidIssuer: 'Wpisz prawidłowy URL HTTPS.', secretRequired: 'Wpisz sekret klienta.', error: 'Zmiana nie została zastosowana.', accounts: 'Dotknięte Accounty', connections: 'Połączenia Teamu', errorForbidden: 'Nie masz już do tego uprawnień. Nic nie zostało zmienione.', errorConflict: 'Ktoś zmienił to wcześniej. Twoje zmiany są zachowane – odśwież i spróbuj ponownie.', errorMissing: 'To już nie istnieje. Mogło zostać usunięte.', errorInUse: 'Coś nadal od tego zależy. Najpierw to usuń.', errorProviderUnavailable: 'Usługa tożsamości nie odpowiedziała. Nic nie zostało zmienione.', errorRateLimited: 'Dostawca poprosił o odczekanie przed kolejną próbą.', errorInvalid: 'Home odrzucił te wartości. Sprawdź konfigurację i spróbuj ponownie.', errorImmutable: 'Tej wartości nie można zmienić po użyciu rekordu. Utwórz nowy.', errorAuthenticationRequired: 'Zaloguj się ponownie do tego Teamu i spróbuj jeszcze raz. Nic nie zostało zmienione.', errorPolicyUnavailable: 'Nie można teraz ocenić zasad uwierzytelniania Teamu. Nic nie zostało zmienione.', errorPolicyInUse: 'Zasady uwierzytelniania Teamu nadal zależą od tego połączenia.', errorNotAllowed: 'Ten Home nie pozwala Teamom tego konfigurować. Nic nie zostało zmienione.', errorNeedsAttention: 'Synchronizacja katalogu wymaga uwagi. Uruchom pełną synchronizację.', errorSyncPaused: 'To źródło jest wstrzymane. „Wznów synchronizację” uruchamia nową pełną synchronizację.', alternateLogins: 'Accounts wymagające innej metody logowania', recoveryAuthenticationPolicy: 'Otwórz uwierzytelnianie Teamu', recoveryAlternateLogin: 'Najpierw nadaj tym Accounts inną metodę logowania', recoveryDirectory: 'Otwórz katalog', recoveryGroupMappings: 'Otwórz mapowania Grup', recoveryTeamAuthentication: 'Zaloguj się ponownie', callbackUrl: 'Adres URL wywołania zwrotnego', callbackUrlHint: 'Zarejestruj ten adres URL u dostawcy tożsamości.' }, 'pl'),
    ru: build({ ...en, title: 'Поставщики идентификации', subtitle: 'Подключения Home для входа в Teams.', homeConnections: 'Подключения Home', add: 'Добавить подключение', empty: 'Нет подключений Home', active: 'Активно', disabled: 'Отключено', configuration: 'Конфигурация', issuer: 'URL издателя', clientSecret: 'Секрет клиента', secretSet: 'Задан', secretNotSet: 'Не задан', secretRetain: 'Оставьте пустым, чтобы сохранить текущий секрет.', advanced: 'Показать дополнительные настройки', hideAdvanced: 'Скрыть дополнительные настройки', actions: 'Действия', test: 'Проверить вход', testing: 'Открывается проверка…', edit: 'Изменить подключение', save: 'Сохранить подключение', saving: 'Сохранение…', enable: 'Включить подключение', disable: 'Отключить подключение', remove: 'Удалить подключение', createTitle: 'Добавить поставщика идентификации', editTitle: 'Изменить поставщика идентификации', displayName: 'Название', required: 'Заполните обязательные поля.', invalidIssuer: 'Введите корректный URL HTTPS.', secretRequired: 'Введите секрет клиента.', error: 'Изменение не применено.', accounts: 'Затронутые Accounts', connections: 'Подключения Team', errorForbidden: 'У вас больше нет прав на это действие. Ничего не изменено.', errorConflict: 'Кто-то изменил это раньше. Ваши правки сохранены — обновите и повторите.', errorMissing: 'Этого больше нет. Возможно, объект удалили.', errorInUse: 'От этого что-то ещё зависит. Сначала удалите зависимости.', errorProviderUnavailable: 'Служба идентификации не ответила. Ничего не изменено.', errorRateLimited: 'Поставщик просит подождать перед повторной попыткой.', errorInvalid: 'Home отклонил эти значения. Проверьте конфигурацию и повторите.', errorImmutable: 'Это значение фиксируется после начала использования. Создайте новую запись.', errorAuthenticationRequired: 'Войдите в этот Team снова и повторите попытку. Ничего не изменено.', errorPolicyUnavailable: 'Политику аутентификации Team сейчас невозможно оценить. Ничего не изменено.', errorPolicyInUse: 'Политика аутентификации Team всё ещё зависит от этого подключения.', errorNotAllowed: 'Этот Home не разрешает Team настраивать это. Ничего не изменено.', errorNeedsAttention: 'Синхронизация каталога требует внимания. Запустите полную синхронизацию.', errorSyncPaused: 'Этот источник приостановлен. «Возобновить синхронизацию» запускает новую полную синхронизацию.', alternateLogins: 'Accounts, которым нужен другой способ входа', recoveryAuthenticationPolicy: 'Открыть аутентификацию Team', recoveryAlternateLogin: 'Сначала дайте этим Accounts другой способ входа', recoveryDirectory: 'Открыть каталог', recoveryGroupMappings: 'Открыть сопоставления Групп', recoveryTeamAuthentication: 'Войти снова', callbackUrl: 'URL обратного вызова', callbackUrlHint: 'Зарегистрируйте этот URL у поставщика идентификации.' }, 'ru'),
    ja: build({ ...en, title: 'ID プロバイダー', subtitle: 'Team で利用できる Home 所有のサインイン接続です。', homeConnections: 'Home のサインイン接続', add: '接続を追加', empty: 'Home の接続はありません', active: '有効', disabled: '無効', configuration: '設定', issuer: '発行者 URL', clientSecret: 'クライアントシークレット', secretSet: '設定済み', secretNotSet: '未設定', secretRetain: '現在のシークレットを保持するには空欄にします。', advanced: '詳細設定を表示', hideAdvanced: '詳細設定を隠す', actions: '操作', test: 'サインインをテスト', testing: 'テストを開いています…', edit: '接続を編集', save: '接続を保存', saving: '保存中…', enable: '接続を有効化', disable: '接続を無効化', remove: '接続を削除', createTitle: 'ID プロバイダーを追加', editTitle: 'ID プロバイダーを編集', displayName: '名前', required: '必須項目を入力してください。', invalidIssuer: '有効な HTTPS URL を入力してください。', secretRequired: 'クライアントシークレットを入力してください。', error: '変更できませんでした。', accounts: '影響する Account', connections: 'Team 接続', errorForbidden: 'この操作の権限がなくなりました。何も変更されていません。', errorConflict: '先に別のユーザーが変更しました。入力内容は保持されています。再読み込みしてからもう一度お試しください。', errorMissing: 'これはすでに存在しません。削除された可能性があります。', errorInUse: 'まだ依存しているものがあります。先にそれを削除してください。', errorProviderUnavailable: 'ID サービスが応答しませんでした。何も変更されていません。', errorRateLimited: 'プロバイダーから、再試行前に待つよう求められました。', errorInvalid: 'Home がこれらの値を拒否しました。設定を確認してもう一度お試しください。', errorImmutable: 'この値は使用開始後は変更できません。新しく作成してください。', errorAuthenticationRequired: 'この Team にもう一度サインインしてから再試行してください。変更はありません。', errorPolicyUnavailable: 'Team の認証ポリシーを現在評価できません。変更はありません。', errorPolicyInUse: 'Team の認証ポリシーはまだこの接続に依存しています。', errorNotAllowed: 'この Home では Team がこれを設定することを許可していません。変更はありません。', errorNeedsAttention: 'ディレクトリ同期に確認が必要です。完全同期を実行してください。', errorSyncPaused: 'このソースは一時停止中です。「同期を再開」で新しい完全同期を開始します。', alternateLogins: '別のサインイン方法が必要な Account', recoveryAuthenticationPolicy: 'Team の認証を開く', recoveryAlternateLogin: '先にこれらの Account に別のサインイン方法を用意してください', recoveryDirectory: 'ディレクトリを開く', recoveryGroupMappings: 'グループの対応付けを開く', recoveryTeamAuthentication: 'もう一度サインイン', callbackUrl: 'コールバック URL', callbackUrlHint: 'この URL を ID プロバイダーに登録してください。' }, 'ja'),
    zhHans: build({ ...en, title: '身份提供商', subtitle: '可供 Team 使用的 Home 登录连接。', homeConnections: 'Home 登录连接', add: '添加连接', empty: '没有 Home 登录连接', active: '已启用', disabled: '已停用', configuration: '配置', issuer: '签发者 URL', clientSecret: '客户端密钥', secretSet: '已设置', secretNotSet: '未设置', secretRetain: '留空以保留当前密钥。', advanced: '显示高级设置', hideAdvanced: '隐藏高级设置', actions: '操作', test: '测试登录', testing: '正在打开测试…', edit: '编辑连接', save: '保存连接', saving: '正在保存…', enable: '启用连接', disable: '停用连接', remove: '移除连接', createTitle: '添加身份提供商', editTitle: '编辑身份提供商', displayName: '名称', required: '请填写必填字段。', invalidIssuer: '请输入有效的 HTTPS URL。', secretRequired: '请输入客户端密钥。', error: '未能应用更改。', accounts: '受影响的 Account', connections: 'Team 连接', errorForbidden: '你已不再拥有此操作的权限。未更改任何内容。', errorConflict: '其他人先做了更改。你的编辑已保留：请重新加载后再试。', errorMissing: '该项已不存在，可能已被移除。', errorInUse: '仍有内容依赖它，请先移除这些内容。', errorProviderUnavailable: '身份服务未响应。未更改任何内容。', errorRateLimited: '提供商要求稍后再试。', errorInvalid: 'Home 拒绝了这些值。请检查配置后再试。', errorImmutable: '记录启用后此值即固定，请改为新建一条。', errorAuthenticationRequired: '请重新登录此 Team 后再试。未更改任何内容。', errorPolicyUnavailable: '目前无法评估 Team 的身份验证策略。未更改任何内容。', errorPolicyInUse: 'Team 的身份验证策略仍依赖此连接。', errorNotAllowed: '此 Home 不允许 Team 配置此项。未更改任何内容。', errorNeedsAttention: '目录同步需要处理。请运行一次完整同步。', errorSyncPaused: '该来源已暂停。“继续同步”会开始一次新的完整同步。', alternateLogins: '需要其他登录方式的 Account', recoveryAuthenticationPolicy: '打开 Team 身份验证', recoveryAlternateLogin: '请先为这些 Account 提供其他登录方式', recoveryDirectory: '打开目录', recoveryGroupMappings: '打开群组映射', recoveryTeamAuthentication: '重新登录', callbackUrl: '回调 URL', callbackUrlHint: '请在你的身份提供商处注册此 URL。' }, 'zhHans'),
    zhHant: build({ ...en, title: '身分提供者', subtitle: '可供 Team 使用的 Home 登入連線。', homeConnections: 'Home 登入連線', add: '新增連線', empty: '沒有 Home 登入連線', active: '已啟用', disabled: '已停用', configuration: '設定', issuer: '簽發者 URL', clientSecret: '用戶端密鑰', secretSet: '已設定', secretNotSet: '未設定', secretRetain: '留空以保留目前的密鑰。', advanced: '顯示進階設定', hideAdvanced: '隱藏進階設定', actions: '操作', test: '測試登入', testing: '正在開啟測試…', edit: '編輯連線', save: '儲存連線', saving: '正在儲存…', enable: '啟用連線', disable: '停用連線', remove: '移除連線', createTitle: '新增身分提供者', editTitle: '編輯身分提供者', displayName: '名稱', required: '請填寫必填欄位。', invalidIssuer: '請輸入有效的 HTTPS URL。', secretRequired: '請輸入用戶端密鑰。', error: '未能套用變更。', accounts: '受影響的 Account', connections: 'Team 連線', errorForbidden: '你已不再擁有此操作的權限。未變更任何內容。', errorConflict: '其他人先做了變更。你的編輯已保留：請重新載入後再試。', errorMissing: '該項目已不存在，可能已被移除。', errorInUse: '仍有內容依賴它，請先移除那些內容。', errorProviderUnavailable: '身分服務未回應。未變更任何內容。', errorRateLimited: '供應商要求稍後再試。', errorInvalid: 'Home 拒絕了這些值。請檢查設定後再試。', errorImmutable: '記錄啟用後此值即固定，請改為新建一筆。', errorAuthenticationRequired: '請重新登入此 Team 後再試。未變更任何內容。', errorPolicyUnavailable: '目前無法評估 Team 的驗證政策。未變更任何內容。', errorPolicyInUse: 'Team 的驗證政策仍依賴此連線。', errorNotAllowed: '此 Home 不允許 Team 設定此項。未變更任何內容。', errorNeedsAttention: '目錄同步需要處理。請執行一次完整同步。', errorSyncPaused: '該來源已暫停。「繼續同步」會開始一次新的完整同步。', alternateLogins: '需要其他登入方式的 Account', recoveryAuthenticationPolicy: '開啟 Team 驗證', recoveryAlternateLogin: '請先為這些 Account 提供其他登入方式', recoveryDirectory: '開啟目錄', recoveryGroupMappings: '開啟群組對應', recoveryTeamAuthentication: '重新登入', callbackUrl: '回呼 URL', callbackUrlHint: '請在你的身分提供者處註冊此 URL。' }, 'zhHant'),
};
