/**
 * Recipient-approval copy for a voice provider's external credential.
 *
 * The approval sheet is one sentence per declared fact — package, publisher, signature,
 * contribution, operations, request, credential header, byte limits — so a single missing leaf
 * renders the sheet half in English while the user is deciding whether to hand a plugin their
 * API key. The block therefore lives here, next to the other voice satellites, rather than being
 * repeated in eleven locale files.
 *
 * `bundled`/`verified`, `read`/`mutation` and `raw`/`bearer` are interpolated INTO those
 * sentences, so they are lower-case words in every locale rather than standalone labels.
 * `bearer` stays literal: it is the HTTP authorization scheme name.
 */
type VoiceExternalCredentialApprovalCopy = Readonly<{
  reviewRequired: string;
  recipientApprovalTitle: string;
  recipientApprovalBody: string;
  recipientApprovalPackage: (args: { title: string; pluginId: string; sourceKind: string; sourceLocator: string }) => string;
  recipientApprovalPublisher: (args: { trust: string; identity: string }) => string;
  recipientApprovalPackageSignature: (args: { status: string; keyId: string }) => string;
  recipientApprovalContribution: (args: { pluginId: string; localId: string }) => string;
  recipientApprovalOperations: string;
  recipientApprovalOperation: (args: { id: string; purpose: string; effect: string }) => string;
  recipientApprovalRequest: (args: { method: string; origin: string; pathTemplate: string }) => string;
  recipientApprovalCredential: (args: { headerName: string; format: string }) => string;
  recipientApprovalBounds: (args: { requestMaxBytes: number; responseMaxBytes: number }) => string;
  recipientApprovalTrust: Readonly<{ bundled: string; verified: string }>;
  recipientApprovalEffect: Readonly<{ read: string; mutation: string }>;
  recipientApprovalCredentialFormat: Readonly<{ raw: string; bearer: string }>;
  recipientApprovalConfirm: string;
}>;

function defineVoiceExternalCredentialApproval(copy: VoiceExternalCredentialApprovalCopy) {
  return copy;
}

export const voiceExternalCredentialApprovalTranslations = {
  ru: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Проверьте доступ к учётным данным',
    recipientApprovalTitle: 'Разрешить этому провайдеру использовать ваши учётные данные?',
    recipientApprovalBody: 'Проверьте и одобрите объявленные адреса и операции провайдера. Если этот контракт получателя изменится, Happier сохранит ваш выбор, но заблокирует использование учётных данных до повторного одобрения.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Пакет: ${title} (${pluginId}); источник: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Издатель: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Подпись пакета: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Вклад: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Объявленные операции:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Операция ${id}: назначение ${purpose}; эффект ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Запрос: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Заголовок с учётными данными: ${headerName}; формат: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Ограничения в байтах: запрос ${requestMaxBytes}; ответ ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'встроенный', verified: 'проверенный' },
    recipientApprovalEffect: { read: 'чтение', mutation: 'изменение' },
    recipientApprovalCredentialFormat: { raw: 'необработанный', bearer: 'bearer' },
    recipientApprovalConfirm: 'Одобрить и сохранить',
  }),
  pl: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Sprawdź dostęp do poświadczeń',
    recipientApprovalTitle: 'Zezwolić temu dostawcy na użycie Twojego poświadczenia?',
    recipientApprovalBody: 'Sprawdź i zatwierdź zadeklarowane punkty końcowe oraz operacje dostawcy. Jeśli ten kontrakt odbiorcy się zmieni, Happier zachowa Twój wybór, ale zablokuje użycie poświadczenia do czasu ponownego zatwierdzenia.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pakiet: ${title} (${pluginId}); źródło: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Wydawca: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Podpis pakietu: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Wkład: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Zadeklarowane operacje:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operacja ${id}: cel ${purpose}; skutek ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Żądanie: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Nagłówek poświadczenia: ${headerName}; format: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limity bajtów: żądanie ${requestMaxBytes}; odpowiedź ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'wbudowany', verified: 'zweryfikowany' },
    recipientApprovalEffect: { read: 'odczyt', mutation: 'modyfikacja' },
    recipientApprovalCredentialFormat: { raw: 'surowy', bearer: 'bearer' },
    recipientApprovalConfirm: 'Zatwierdź i zapisz',
  }),
  es: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Revisa el acceso a las credenciales',
    recipientApprovalTitle: '¿Permitir que este proveedor use tu credencial?',
    recipientApprovalBody: 'Revisa y aprueba los endpoints y las operaciones declarados del proveedor. Si ese contrato de destinatario cambia, Happier conserva tu selección pero bloquea el uso de la credencial hasta que la apruebes de nuevo.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquete: ${title} (${pluginId}); fuente: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Firma del paquete: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribución: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operaciones declaradas:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operación ${id}: propósito ${purpose}; efecto ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Solicitud: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Cabecera de la credencial: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Límites de bytes: solicitud ${requestMaxBytes}; respuesta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrado', verified: 'verificado' },
    recipientApprovalEffect: { read: 'lectura', mutation: 'mutación' },
    recipientApprovalCredentialFormat: { raw: 'sin formato', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprobar y guardar',
  }),
  fr: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Vérifie l’accès aux identifiants',
    recipientApprovalTitle: 'Autoriser ce provider à utiliser ton identifiant ?',
    recipientApprovalBody: 'Vérifie et approuve les endpoints et les opérations déclarés du provider. Si ce contrat de destinataire change, Happier conserve ta sélection mais bloque l’utilisation de l’identifiant jusqu’à une nouvelle approbation.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquet : ${title} (${pluginId}) ; source : ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Éditeur : ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Signature du paquet : ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribution : ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Opérations déclarées :',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Opération ${id} : finalité ${purpose} ; effet ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Requête : ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `En-tête d’identifiant : ${headerName} ; format : ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limites d’octets : requête ${requestMaxBytes} ; réponse ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'intégré', verified: 'vérifié' },
    recipientApprovalEffect: { read: 'lecture', mutation: 'mutation' },
    recipientApprovalCredentialFormat: { raw: 'brut', bearer: 'bearer' },
    recipientApprovalConfirm: 'Approuver et enregistrer',
  }),
  it: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Verifica l’accesso alle credenziali',
    recipientApprovalTitle: 'Consentire a questo provider di usare la tua credenziale?',
    recipientApprovalBody: 'Verifica e approva gli endpoint e le operazioni dichiarati dal provider. Se quel contratto del destinatario cambia, Happier mantiene la tua selezione ma blocca l’uso della credenziale finché non la approvi di nuovo.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pacchetto: ${title} (${pluginId}); origine: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editore: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Firma del pacchetto: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contributo: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operazioni dichiarate:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operazione ${id}: finalità ${purpose}; effetto ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Richiesta: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Intestazione della credenziale: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limiti di byte: richiesta ${requestMaxBytes}; risposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrato', verified: 'verificato' },
    recipientApprovalEffect: { read: 'lettura', mutation: 'modifica' },
    recipientApprovalCredentialFormat: { raw: 'grezzo', bearer: 'bearer' },
    recipientApprovalConfirm: 'Approva e salva',
  }),
  pt: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Reveja o acesso às credenciais',
    recipientApprovalTitle: 'Permitir que este fornecedor utilize a sua credencial?',
    recipientApprovalBody: 'Reveja e aprove os endpoints e as operações declarados do fornecedor. Se esse contrato do destinatário mudar, o Happier mantém a sua seleção mas bloqueia o uso da credencial até que a aprove novamente.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pacote: ${title} (${pluginId}); origem: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Assinatura do pacote: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribuição: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operações declaradas:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operação ${id}: finalidade ${purpose}; efeito ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Pedido: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Cabeçalho da credencial: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limites de bytes: pedido ${requestMaxBytes}; resposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrado', verified: 'verificado' },
    recipientApprovalEffect: { read: 'leitura', mutation: 'alteração' },
    recipientApprovalCredentialFormat: { raw: 'em bruto', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprovar e guardar',
  }),
  ca: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Revisa l’accés a les credencials',
    recipientApprovalTitle: 'Vols permetre que aquest proveïdor utilitzi la teva credencial?',
    recipientApprovalBody: 'Revisa i aprova els punts finals i les operacions declarats del proveïdor. Si aquest contracte del destinatari canvia, Happier manté la teva selecció però bloqueja l’ús de la credencial fins que la tornis a aprovar.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquet: ${title} (${pluginId}); font: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Signatura del paquet: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribució: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operacions declarades:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operació ${id}: finalitat ${purpose}; efecte ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Sol·licitud: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Capçalera de la credencial: ${headerName}; format: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Límits de bytes: sol·licitud ${requestMaxBytes}; resposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrat', verified: 'verificat' },
    recipientApprovalEffect: { read: 'lectura', mutation: 'mutació' },
    recipientApprovalCredentialFormat: { raw: 'en brut', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprova i desa',
  }),
  'zh-Hans': defineVoiceExternalCredentialApproval({
    reviewRequired: '检查凭据访问权限',
    recipientApprovalTitle: '允许此提供商使用你的凭据？',
    recipientApprovalBody: '请检查并批准声明的提供商端点和操作。如果该接收方约定发生变化，Happier 会保留你的选择，但会阻止使用凭据，直到你再次批准。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `包：${title}（${pluginId}）；来源：${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `发布者：${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `包签名：${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `贡献：${pluginId}/${localId}`,
    recipientApprovalOperations: '已声明的操作：',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}：用途 ${purpose}；影响 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `请求：${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `凭据请求头：${headerName}；格式：${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `字节上限：请求 ${requestMaxBytes}；响应 ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: '内置', verified: '已验证' },
    recipientApprovalEffect: { read: '读取', mutation: '变更' },
    recipientApprovalCredentialFormat: { raw: '原始', bearer: 'bearer' },
    recipientApprovalConfirm: '批准并保存',
  }),
  'zh-Hant': defineVoiceExternalCredentialApproval({
    reviewRequired: '檢查憑證存取權',
    recipientApprovalTitle: '允許此供應商使用你的憑證？',
    recipientApprovalBody: '請檢查並核准宣告的供應商端點與操作。如果該接收方約定變更，Happier 會保留你的選擇，但會阻擋憑證使用，直到你再次核准。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `套件：${title}（${pluginId}）；來源：${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `發布者：${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `套件簽章：${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `貢獻：${pluginId}/${localId}`,
    recipientApprovalOperations: '已宣告的操作：',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}：用途 ${purpose}；影響 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `請求：${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `憑證標頭：${headerName}；格式：${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `位元組上限：請求 ${requestMaxBytes}；回應 ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: '內建', verified: '已驗證' },
    recipientApprovalEffect: { read: '讀取', mutation: '變更' },
    recipientApprovalCredentialFormat: { raw: '原始', bearer: 'bearer' },
    recipientApprovalConfirm: '核准並儲存',
  }),
  ja: defineVoiceExternalCredentialApproval({
    reviewRequired: '認証情報へのアクセスを確認',
    recipientApprovalTitle: 'このプロバイダーに認証情報の使用を許可しますか？',
    recipientApprovalBody: '宣言されたプロバイダーのエンドポイントと操作を確認して承認してください。受信側の契約が変わった場合、Happier は選択を保持したまま、再度承認するまで認証情報の使用をブロックします。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `パッケージ: ${title}（${pluginId}）; ソース: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `発行者: ${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `パッケージ署名: ${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `コントリビューション: ${pluginId}/${localId}`,
    recipientApprovalOperations: '宣言された操作:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}: 目的 ${purpose}; 影響 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `リクエスト: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `認証情報ヘッダー: ${headerName}; 形式: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `バイト上限: リクエスト ${requestMaxBytes}; レスポンス ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'バンドル', verified: '検証済み' },
    recipientApprovalEffect: { read: '読み取り', mutation: '変更' },
    recipientApprovalCredentialFormat: { raw: '生', bearer: 'bearer' },
    recipientApprovalConfirm: '承認して保存',
  }),
} as const;
